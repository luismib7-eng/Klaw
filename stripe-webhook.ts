/**
 * POST /api/stripe-webhook · Klaw
 *
 * Abona créditos y actualiza el plan del workspace a partir de eventos de Stripe.
 *
 * Convenciones que deben configurarse en Stripe (Dashboard → Productos → Precio → Metadatos):
 *   · Paquetes de créditos (pago único):  metadata.credits = "500"
 *   · Suscripciones:                      metadata.plan    = "creador" | "pro" | "agencia"
 * El workspace se identifica con client_reference_id: el frontend abre el Payment Link como
 *   https://buy.stripe.com/...?client_reference_id=<workspace_id>
 *
 * Eventos atendidos:
 *   checkout.session.completed           pago único → abona créditos; suscripción → vincula plan
 *   checkout.session.async_payment_succeeded  pagos diferidos (p. ej., OXXO) → igual que el anterior
 *   invoice.paid                         cada cobro de suscripción → abona los créditos mensuales del plan
 *   customer.subscription.deleted        cancelación → el workspace regresa a plan de prueba vencido
 *
 * Idempotencia: grant_credits registra el id del evento; si Stripe reintenta, no se abona dos veces.
 */
import Stripe from "stripe";
import { PLANS, type PlanId } from "../saas/entitlements.js";
import { env } from "../server/lib/env.js";
import { admin } from "../server/lib/supabase.js";

let stripeClient: Stripe | null = null;
const stripe = () => (stripeClient ??= new Stripe(env("STRIPE_SECRET_KEY")));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID_PLANS: PlanId[] = ["creador", "pro", "agencia"];

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Deja constancia de eventos que no abonan créditos (sin workspace o irrelevantes). */
async function recordEvent(event: Stripe.Event, status: "ignored" | "unmatched", workspaceId: string | null, detail: object) {
  const { error } = await admin()
    .from("stripe_events")
    .upsert({ id: event.id, type: event.type, workspace_id: workspaceId, status, detail }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

/** Devuelve el id si corresponde a un workspace existente; si no, null. */
async function existingWorkspace(id: string | null | undefined): Promise<string | null> {
  if (!id || !UUID.test(id)) return null;
  const { data, error } = await admin().from("workspaces").select("id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? id : null;
}

async function grant(workspaceId: string, amount: number, reason: "grant" | "purchase", event: Stripe.Event, note: string) {
  const { data, error } = await admin().rpc("grant_credits", {
    p_workspace_id: workspaceId,
    p_amount: amount,
    p_reason: reason,
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_note: note,
  });
  if (error) throw error;
  return data as boolean; // false = evento ya procesado
}

// ─────────────────────────── Checkout ───────────────────────────

async function onCheckout(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status === "unpaid") {
    // Pago diferido pendiente: se abona al llegar checkout.session.async_payment_succeeded.
    await recordEvent(event, "ignored", null, { session: session.id, reason: "payment_pending" });
    return;
  }

  const workspaceId = await existingWorkspace(session.client_reference_id);
  if (!workspaceId) {
    await recordEvent(event, "unmatched", null, {
      session: session.id,
      client_reference_id: session.client_reference_id,
      email: session.customer_details?.email ?? null,
      reason: "Sin client_reference_id válido: conciliar manualmente",
    });
    return;
  }

  const items = await stripe().checkout.sessions.listLineItems(session.id, { limit: 100, expand: ["data.price"] });

  if (session.mode === "subscription") {
    const plan = items.data.map((li) => li.price?.metadata?.plan).find((p): p is PlanId => PAID_PLANS.includes(p as PlanId));
    if (!plan) {
      await recordEvent(event, "unmatched", workspaceId, { session: session.id, reason: "El precio no tiene metadata.plan" });
      return;
    }
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
    const { error } = await admin()
      .from("workspaces")
      .update({ plan, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq("id", workspaceId);
    if (error) throw error;
    // Los créditos mensuales se abonan en invoice.paid para no duplicarlos.
    await recordEvent(event, "ignored", workspaceId, { session: session.id, plan, reason: "Plan vinculado; créditos vía invoice.paid" });
    return;
  }

  const credits = items.data.reduce((sum, li) => sum + (Number(li.price?.metadata?.credits) || 0) * (li.quantity ?? 1), 0);
  if (credits <= 0) {
    await recordEvent(event, "unmatched", workspaceId, { session: session.id, reason: "Ningún precio tiene metadata.credits" });
    return;
  }
  await grant(workspaceId, credits, "purchase", event, `Compra de créditos (${session.id})`);
}

// ─────────────────────────── Suscripciones ───────────────────────────

function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/** Busca el workspace por suscripción; si aún no está vinculado, lo toma del Checkout que la creó. */
async function workspaceForSubscription(subscriptionId: string): Promise<string | null> {
  const { data, error } = await admin()
    .from("workspaces")
    .select("id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (data?.id) return data.id as string;

  const sessions = await stripe().checkout.sessions.list({ subscription: subscriptionId, limit: 1 });
  return existingWorkspace(sessions.data[0]?.client_reference_id);
}

async function onInvoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = subscriptionIdOf(invoice);
  if (!subscriptionId) {
    await recordEvent(event, "ignored", null, { invoice: invoice.id, reason: "Factura sin suscripción" });
    return;
  }
  if (invoice.amount_paid <= 0) {
    // Factura de $0 (periodo de prueba): los créditos de prueba ya se abonaron al registrarse.
    await recordEvent(event, "ignored", null, { invoice: invoice.id, reason: "Factura sin cobro (prueba)" });
    return;
  }

  const workspaceId = await workspaceForSubscription(subscriptionId);
  if (!workspaceId) {
    await recordEvent(event, "unmatched", null, { invoice: invoice.id, subscription: subscriptionId });
    return;
  }

  const subscription = await stripe().subscriptions.retrieve(subscriptionId);
  const plan = subscription.items.data
    .map((item) => item.price.metadata?.plan)
    .find((p): p is PlanId => PAID_PLANS.includes(p as PlanId));
  if (!plan) {
    await recordEvent(event, "unmatched", workspaceId, { invoice: invoice.id, reason: "El precio no tiene metadata.plan" });
    return;
  }

  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  const { error } = await admin()
    .from("workspaces")
    .update({ plan, stripe_subscription_id: subscriptionId, stripe_customer_id: customerId })
    .eq("id", workspaceId);
  if (error) throw error;

  await grant(workspaceId, PLANS[plan].monthlyCredits, "grant", event, `Créditos mensuales plan ${plan} (${invoice.id})`);
}

async function onSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const { data, error } = await admin()
    .from("workspaces")
    .update({ plan: "trial", trial_ends_at: new Date().toISOString(), stripe_subscription_id: null })
    .eq("stripe_subscription_id", subscription.id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  await recordEvent(event, "ignored", (data?.id as string | undefined) ?? null, { subscription: subscription.id, reason: "Plan cancelado" });
}

// ─────────────────────────── Handler ───────────────────────────

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return reply(400, { error: "Falta la firma de Stripe." });

  // La firma se verifica sobre el cuerpo crudo: no se debe parsear antes.
  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, env("STRIPE_WEBHOOK_SECRET"));
  } catch (err) {
    console.warn("[klaw] firma de Stripe inválida", err);
    return reply(400, { error: "Firma inválida." });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await onCheckout(event);
        break;
      case "invoice.paid":
        await onInvoicePaid(event);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionDeleted(event);
        break;
      default:
        break; // Otros eventos no requieren acción.
    }
    return reply(200, { received: true });
  } catch (err) {
    // 500 hace que Stripe reintente; la idempotencia evita abonos duplicados.
    console.error("[klaw] error procesando evento de Stripe", event.id, err);
    return reply(500, { error: "Error procesando el evento." });
  }
}
