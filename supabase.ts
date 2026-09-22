/**
 * Cliente de Supabase con service_role (solo servidor) y verificación de identidad.
 * La llave service_role omite la RLS: nunca debe llegar al navegador.
 */
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { env } from "./env.js";
import { HttpError } from "./http.js";

let client: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  client ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Valida el JWT de Supabase Auth enviado como "Authorization: Bearer <access_token>". */
export async function requireUser(request: Request): Promise<User> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "UNAUTHENTICATED", "Inicia sesión para continuar.");
  const { data, error } = await admin().auth.getUser(match[1]);
  if (error || !data.user) throw new HttpError(401, "UNAUTHENTICATED", "La sesión no es válida o expiró.");
  return data.user;
}

export type MemberRole = "owner" | "editor" | "viewer";

/** Exige que el usuario pertenezca al workspace con alguno de los roles indicados. */
export async function requireRole(workspaceId: string, userId: string, roles: MemberRole[]): Promise<MemberRole> {
  const { data, error } = await admin()
    .from("members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const role = data?.role as MemberRole | undefined;
  if (!role || !roles.includes(role)) {
    throw new HttpError(403, "FORBIDDEN", "No tienes permiso para esta acción en este espacio de trabajo.");
  }
  return role;
}

export async function creditBalance(workspaceId: string): Promise<number> {
  const { data, error } = await admin()
    .from("credit_balances")
    .select("balance")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return (data?.balance as number | undefined) ?? 0;
}
