-- ═══════════════════════════════════════════════════════════════════════════
-- Klaw · 001_init.sql
-- Esquema multiinquilino (workspaces), usuarios, proyectos, render jobs y libro
-- mayor de créditos con reserva y liquidación atómicas. PostgreSQL 15+ (Supabase).
--
-- Reglas de diseño (PRD, secciones 4.2 y 4.4):
--   · El saldo NO se guarda como campo editable: es la suma de credits_ledger.delta.
--   · Toda escritura de créditos pasa por funciones SECURITY DEFINER que solo puede
--     ejecutar el backend (service_role). El cliente nunca escribe créditos.
--   · deduct_credits bloquea la fila del workspace: dos cargos simultáneos se
--     serializan y ninguno puede dejar el saldo en negativo.
--   · settle_credits y grant_credits son idempotentes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── Tipos ───────────────────────────

create type public.plan_id       as enum ('trial', 'creador', 'pro', 'agencia');
create type public.member_role   as enum ('owner', 'editor', 'viewer');
create type public.job_kind      as enum ('generate', 'export');
create type public.job_status    as enum ('queued', 'scripting', 'voicing', 'illustrating', 'syncing', 'rendering', 'done', 'failed', 'canceled');
create type public.ledger_reason as enum ('grant', 'purchase', 'reserve', 'settle', 'refund', 'adjust');

-- ─────────────────────────── Usuarios e inquilinos ───────────────────────────

-- Perfil público de cada cuenta de Supabase Auth (se crea con el trigger on_auth_user_created).
create table public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  plan                   public.plan_id not null default 'trial',
  trial_ends_at          timestamptz default now() + interval '14 days',
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  brand_kit              jsonb not null default '{}'::jsonb,
  created_by             uuid references public.users (id) on delete set null,
  created_at             timestamptz not null default now()
);

create table public.members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         public.member_role not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index members_user_idx on public.members (user_id);

-- ─────────────────────────── Proyectos ───────────────────────────

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by   uuid references public.users (id) on delete set null,
  title        text not null default 'Sin título',
  source_kind  text not null check (source_kind in ('prompt', 'url', 'document')),
  source_ref   text,
  language     text not null default 'es-MX',
  voice_id     text,
  storyboard   jsonb,   -- salida validada del Paso A
  timeline     jsonb,   -- escenas con trazos programados (Paso D); fuente única de verdad
  duration_sec numeric(7, 2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index projects_workspace_idx on public.projects (workspace_id, updated_at desc);

-- ─────────────────────────── Render jobs ───────────────────────────
-- kind = 'generate': guion + voz + sincronización (vista previa en el Player).
-- kind = 'export'  : render MP4 en Remotion Lambda.

create table public.render_jobs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  created_by         uuid references public.users (id) on delete set null,
  kind               public.job_kind not null default 'export',
  status             public.job_status not null default 'queued',
  progress           real not null default 0 check (progress between 0 and 1),
  height             int not null check (height in (480, 720, 1080)),
  watermark          boolean not null,
  credits_reserved   int not null default 0 check (credits_reserved >= 0),
  credits_charged    int check (credits_charged >= 0),  -- nulo hasta liquidar
  provider_render_id text,
  output_path        text,
  error              text,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);
create index render_jobs_workspace_idx on public.render_jobs (workspace_id, created_at desc);
create index render_jobs_active_idx on public.render_jobs (status) where status not in ('done', 'failed', 'canceled');

-- ─────────────────────────── Créditos ───────────────────────────

create table public.credits_ledger (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  delta         int not null check (delta <> 0),
  reason        public.ledger_reason not null,
  render_job_id uuid references public.render_jobs (id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);
create index credits_ledger_workspace_idx on public.credits_ledger (workspace_id);

-- security_invoker: la vista respeta la RLS de credits_ledger (cada quien ve solo su saldo).
create view public.credit_balances with (security_invoker = true) as
  select workspace_id, coalesce(sum(delta), 0)::int as balance
  from public.credits_ledger
  group by workspace_id;

-- Registro de eventos de Stripe ya procesados (idempotencia del webhook).
create table public.stripe_events (
  id           text primary key,  -- evt_...
  type         text not null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  status       text not null check (status in ('processed', 'ignored', 'unmatched')),
  detail       jsonb,
  created_at   timestamptz not null default now()
);

-- ─────────────────────────── Funciones de créditos ───────────────────────────

-- Cargo atómico. Devuelve false (sin cargar nada) si el saldo no alcanza.
create or replace function public.deduct_credits(
  p_workspace_id  uuid,
  p_amount        int,
  p_render_job_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'deduct_credits: el monto debe ser positivo (recibido: %)', p_amount;
  end if;

  -- Serializa todos los cargos del workspace.
  perform 1 from workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'deduct_credits: workspace % no existe', p_workspace_id;
  end if;

  select coalesce(sum(delta), 0) into v_balance
  from credits_ledger
  where workspace_id = p_workspace_id;

  if v_balance < p_amount then
    return false;
  end if;

  insert into credits_ledger (workspace_id, delta, reason, render_job_id)
  values (p_workspace_id, -p_amount, 'reserve', p_render_job_id);

  if p_render_job_id is not null then
    update render_jobs
       set credits_reserved = credits_reserved + p_amount
     where id = p_render_job_id and workspace_id = p_workspace_id;
  end if;

  return true;
end $$;

-- Liquidación idempotente: devuelve lo reservado y no consumido.
-- p_actual = 0 reembolsa todo (job fallido o cancelado).
create or replace function public.settle_credits(p_render_job_id uuid, p_actual int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j render_jobs;
  v_actual int;
begin
  select * into j from render_jobs where id = p_render_job_id for update;
  if not found then
    raise exception 'settle_credits: render job % no existe', p_render_job_id;
  end if;
  if j.credits_charged is not null then
    return;  -- ya liquidado: un webhook repetido no cobra ni reembolsa dos veces
  end if;

  v_actual := least(greatest(coalesce(p_actual, 0), 0), j.credits_reserved);

  if j.credits_reserved - v_actual <> 0 then
    insert into credits_ledger (workspace_id, delta, reason, render_job_id)
    values (j.workspace_id, j.credits_reserved - v_actual,
            (case when v_actual = 0 then 'refund' else 'settle' end)::ledger_reason, p_render_job_id);
  end if;

  update render_jobs set credits_charged = v_actual where id = p_render_job_id;
end $$;

-- Abono de créditos (compras, planes, ajustes). Si recibe p_stripe_event_id, un evento
-- repetido devuelve false y no abona dos veces.
create or replace function public.grant_credits(
  p_workspace_id    uuid,
  p_amount          int,
  p_reason          ledger_reason default 'purchase',
  p_stripe_event_id text default null,
  p_event_type      text default null,
  p_note            text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'grant_credits: el monto debe ser positivo (recibido: %)', p_amount;
  end if;
  if p_reason not in ('grant', 'purchase', 'adjust') then
    raise exception 'grant_credits: motivo no permitido (%)', p_reason;
  end if;

  if p_stripe_event_id is not null then
    insert into stripe_events (id, type, workspace_id, status)
    values (p_stripe_event_id, coalesce(p_event_type, 'unknown'), p_workspace_id, 'processed')
    on conflict (id) do nothing;
    if not found then
      return false;
    end if;
  end if;

  perform 1 from workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'grant_credits: workspace % no existe', p_workspace_id;
  end if;

  insert into credits_ledger (workspace_id, delta, reason, note)
  values (p_workspace_id, p_amount, p_reason, p_note);
  return true;
end $$;

-- Pertenencia a un workspace; SECURITY DEFINER evita recursión en las políticas de members.
create or replace function public.is_member(p_workspace_id uuid, p_roles member_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

-- ─────────────────────────── Alta automática de cuentas ───────────────────────────
-- Cada registro en Supabase Auth crea: perfil, workspace personal en plan de prueba,
-- membresía como owner y los 150 créditos del plan de prueba (PLANS.trial).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_name text := coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1));
begin
  insert into users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');

  insert into workspaces (name, created_by)
  values (coalesce('Espacio de ' || nullif(v_name, ''), 'Mi espacio'), new.id)
  returning id into v_workspace;

  insert into members (workspace_id, user_id, role) values (v_workspace, new.id, 'owner');

  insert into credits_ledger (workspace_id, delta, reason, note)
  values (v_workspace, 150, 'grant', 'Créditos del plan de prueba');

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ─────────────────────────── Permisos de ejecución ───────────────────────────
-- Supabase concede EXECUTE por defecto a anon y authenticated: se retira en las
-- funciones de dinero para que solo el backend (service_role) pueda llamarlas.

revoke execute on function public.deduct_credits(uuid, int, uuid) from public, anon, authenticated;
revoke execute on function public.settle_credits(uuid, int) from public, anon, authenticated;
revoke execute on function public.grant_credits(uuid, int, ledger_reason, text, text, text) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.deduct_credits(uuid, int, uuid) to service_role;
grant execute on function public.settle_credits(uuid, int) to service_role;
grant execute on function public.grant_credits(uuid, int, ledger_reason, text, text, text) to service_role;
grant execute on function public.is_member(uuid, member_role[]) to authenticated;

-- ─────────────────────────── Seguridad a nivel de fila ───────────────────────────
-- service_role omite la RLS. Sin política = sin acceso para anon/authenticated.

alter table public.users          enable row level security;
alter table public.workspaces     enable row level security;
alter table public.members        enable row level security;
alter table public.projects       enable row level security;
alter table public.render_jobs    enable row level security;
alter table public.credits_ledger enable row level security;
alter table public.stripe_events  enable row level security;

create policy users_self_read on public.users
  for select to authenticated using (id = auth.uid());
create policy users_self_update on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy workspaces_member_read on public.workspaces
  for select to authenticated using (public.is_member(id));

create policy members_member_read on public.members
  for select to authenticated using (public.is_member(workspace_id));

create policy projects_member_read on public.projects
  for select to authenticated using (public.is_member(workspace_id));
create policy projects_editor_insert on public.projects
  for insert to authenticated with check (public.is_member(workspace_id, array['owner', 'editor']::member_role[]));
create policy projects_editor_update on public.projects
  for update to authenticated
  using (public.is_member(workspace_id, array['owner', 'editor']::member_role[]))
  with check (public.is_member(workspace_id, array['owner', 'editor']::member_role[]));
create policy projects_editor_delete on public.projects
  for delete to authenticated using (public.is_member(workspace_id, array['owner', 'editor']::member_role[]));

create policy render_jobs_member_read on public.render_jobs
  for select to authenticated using (public.is_member(workspace_id));

create policy credits_ledger_member_read on public.credits_ledger
  for select to authenticated using (public.is_member(workspace_id));

-- stripe_events: sin políticas; solo el backend lo lee y escribe.
