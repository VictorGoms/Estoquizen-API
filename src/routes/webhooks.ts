import type { FastifyPluginAsync } from "fastify";
import Stripe from "stripe";
import { stripe, PRICE_IDS } from "../lib/stripe.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { getLimits } from "../lib/plans.js";
import { sendSubscriptionConfirmedEmail, sendPlanChangedEmail, sendCancelScheduledEmail } from "../lib/resend.js";

type LocalStatus = "active" | "past_due" | "canceled";

/* Status do Stripe → status local. O CHECK de subscriptions não aceita incomplete, unpaid nem paused.
   null = não mexe no status (o primeiro pagamento ainda não foi concluído). */
function mapStatus(status: Stripe.Subscription.Status): LocalStatus | null {
  switch (status) {
    case "active":
    case "trialing":           return "active";
    case "past_due":           return "past_due";
    case "unpaid":
    case "paused":
    case "canceled":           return "canceled";
    case "incomplete":
    case "incomplete_expired": return null;
  }
}

/* Na API dahlia o fim do período fica nos itens da assinatura, não na assinatura */
function periodEnd(sub: Stripe.Subscription): { current_period_end?: string } {
  const end = sub.items.data[0]?.current_period_end;
  return end ? { current_period_end: new Date(end * 1000).toISOString() } : {};
}

/* O plano vem do preço, que muda se a pessoa troca de plano; o metadata guarda o plano da compra */
function planOf(sub: Stripe.Subscription): string {
  const priceId = sub.items.data[0]?.price.id;
  const fromPrice = Object.entries(PRICE_IDS).find(([, id]) => id && id === priceId)?.[0];
  return fromPrice ?? sub.metadata?.plan ?? "basic";
}

/*
 * E-mail "Assinatura confirmada" para o dono do workspace, uma vez por assinatura (o Stripe pode
 * reenviar o evento). Falha no e-mail só vai para o log: não deve fazer o Stripe reenviar o evento.
 */
async function avisarAssinaturaConfirmada(
  wsId: string, plan: string, subId: string, session: Stripe.Checkout.Session,
  log: { error: (obj: object, msg: string) => void },
) {
  try {
    const { data: row } = await supabaseAdmin
      .from("subscriptions").select("confirmation_email_sub_id").eq("workspace_id", wsId).maybeSingle();
    if (row?.confirmation_email_sub_id === subId) return;

    const { data: ws } = await supabaseAdmin.from("workspaces").select("name, created_by").eq("id", wsId).maybeSingle();
    if (!ws) return;
    const { data: dono } = await supabaseAdmin.from("profiles").select("email").eq("id", ws.created_by).maybeSingle();
    const to = dono?.email ?? session.customer_details?.email;
    if (!to) return;

    const sub  = await stripe.subscriptions.retrieve(subId);
    const item = sub.items.data[0];
    await sendSubscriptionConfirmedEmail({
      to,
      workspaceName:   ws.name,
      planLabel:       getLimits(plan).label,
      pagoHoje:        session.amount_total ?? 0,
      mensal:          item?.price.unit_amount ?? 0,
      proximaCobranca: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    });

    const { error } = await supabaseAdmin
      .from("subscriptions").update({ confirmation_email_sub_id: subId }).eq("workspace_id", wsId);
    if (error) log.error({ err: error, wsId }, "e-mail de assinatura enviado, mas a marca não gravou");
  } catch (err) {
    log.error({ err, wsId, subId }, "falha ao mandar o e-mail de assinatura confirmada");
  }
}

const ORDEM_PLANOS = ["basic", "growth", "pro"];

/*
 * E-mails de mudança numa assinatura paga que já existia (EQZ-07): plano trocado pelo portal e
 * cancelamento agendado. A mudança vem do previous_attributes do evento, não do banco: o
 * invoice.paid da troca também grava o plano novo e pode chegar antes. Só vale para a assinatura
 * já gravada no workspace (a primeira compra tem o e-mail "Assinatura confirmada").
 * Falha no e-mail só vai para o log.
 */
async function avisarMudancaNaAssinatura(
  wsId: string, sub: Stripe.Subscription, anterior: Partial<Stripe.Subscription> | undefined,
  subGravada: string | null | undefined,
  log: { error: (obj: object, msg: string) => void },
) {
  if (!anterior || subGravada !== sub.id) return;
  const plan        = planOf(sub);
  const precoAntes  = anterior.items?.data?.[0]?.price?.id;
  const planoAntes  = precoAntes ? Object.entries(PRICE_IDS).find(([, id]) => id && id === precoAntes)?.[0] : undefined;
  const trocou      = !!planoAntes && planoAntes !== plan;
  const cancelando  = sub.cancel_at_period_end || sub.cancel_at !== null;
  const mudouCancel = "cancel_at_period_end" in anterior || "cancel_at" in anterior;
  const agendou     = cancelando && mudouCancel && !anterior.cancel_at_period_end && !anterior.cancel_at;
  if (!trocou && !agendou) return;

  try {
    const { data: ws } = await supabaseAdmin.from("workspaces").select("name, created_by").eq("id", wsId).maybeSingle();
    if (!ws) return;
    const { data: dono } = await supabaseAdmin.from("profiles").select("email").eq("id", ws.created_by).maybeSingle();
    if (!dono?.email) return;

    if (trocou) {
      await sendPlanChangedEmail({
        to: dono.email, workspaceName: ws.name,
        de: getLimits(planoAntes!).label, para: getLimits(plan).label, preco: getLimits(plan).price,
        subiu: ORDEM_PLANOS.indexOf(plan) > ORDEM_PLANOS.indexOf(planoAntes!),
      });
    }
    if (agendou) {
      const fim = sub.cancel_at ?? sub.items.data[0]?.current_period_end;
      if (fim) await sendCancelScheduledEmail({ to: dono.email, workspaceName: ws.name, acessoAte: new Date(fim * 1000) });
    }
  } catch (err) {
    log.error({ err, wsId, subId: sub.id }, "falha ao mandar o e-mail de mudança na assinatura");
  }
}

/* O supabase-js não lança exceção: devolve { error }. Lança aqui para o Stripe receber 500 e reenviar. */
async function updateSubscription(wsId: string, fields: Record<string, unknown>) {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("workspace_id", wsId);
  if (error) throw new Error(`subscriptions (${wsId}): ${error.message}`);
}

async function updateWorkspacePlan(wsId: string, plan: string) {
  const { error } = await supabaseAdmin
    .from("workspaces")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("id", wsId);
  if (error) throw new Error(`workspaces (${wsId}): ${error.message}`);
}

/* Eventos de uma assinatura que não é a atual do workspace (ex.: a antiga, depois de assinar de novo)
   não podem mexer no status. Sem assinatura gravada ainda, aceita. */
async function isCurrentSubscription(wsId: string, subId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("workspace_id", wsId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions (${wsId}): ${error.message}`);
  return !data?.stripe_subscription_id || data.stripe_subscription_id === subId;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const ref = invoice.parent?.subscription_details?.subscription;
  return typeof ref === "string" ? ref : ref?.id;
}

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/webhooks/stripe", async (req, reply) => {
    const sig    = req.headers["stripe-signature"] as string;
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

    let event: Stripe.Event;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawBody = (req as any).rawBody as Buffer | string | undefined;
      if (!rawBody) return reply.status(400).send({ error: "Raw body não disponível" });
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      fastify.log.error({ msg }, "Webhook Stripe: falha na verificação");
      return reply.status(400).send({ error: `Webhook Error: ${msg}` });
    }

    try {
      switch (event.type) {

        /* Mais confiável para a primeira cobrança — metadata direto na session */
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const wsId = session.metadata?.workspace_id;
          const plan = (session.metadata?.plan ?? "basic") as string;
          if (!wsId || session.payment_status !== "paid") break;

          const subId  = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
          const custId = typeof session.customer     === "string" ? session.customer     : session.customer?.id;

          /* Assinatura nova: zera o que era da anterior (o cancelamento agendado de uma Basic antiga
             ficava marcado na Pro nova e escondia o "Cancelar assinatura") */
          await updateSubscription(wsId, {
            status: "active",
            plan,
            cancel_at_period_end: false,
            paused_until:         null,
            ...(custId ? { stripe_customer_id: custId } : {}),
            ...(subId  ? { stripe_subscription_id: subId } : {}),
          });
          await updateWorkspacePlan(wsId, plan);
          if (subId) await avisarAssinaturaConfirmada(wsId, plan, subId, session, fastify.log);

          fastify.log.info({ wsId, plan, subId }, "checkout.session.completed → assinatura ativada");
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const subId = invoiceSubscriptionId(invoice);
          if (!subId) break;

          const sub  = await stripe.subscriptions.retrieve(subId);
          const wsId = sub.metadata?.workspace_id;
          if (!wsId) break;

          const plan   = planOf(sub);
          const custId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

          await updateSubscription(wsId, {
            status:                 "active",
            plan,
            stripe_subscription_id: subId,
            ...(custId ? { stripe_customer_id: custId } : {}),
            stripe_price_id:        sub.items.data[0]?.price.id,
            ...periodEnd(sub),
          });
          await updateWorkspacePlan(wsId, plan);

          fastify.log.info({ wsId, plan, subId }, "invoice.paid → assinatura ativada");
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const subId = invoiceSubscriptionId(invoice);
          if (!subId) break;

          const sub  = await stripe.subscriptions.retrieve(subId);
          const wsId = sub.metadata?.workspace_id;
          if (!wsId || !await isCurrentSubscription(wsId, subId)) break;

          await updateSubscription(wsId, { status: "past_due" });
          fastify.log.info({ wsId, subId }, "invoice.payment_failed → past_due");
          break;
        }

        case "customer.subscription.updated": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          if (!wsId || !await isCurrentSubscription(wsId, sub.id)) break;

          const plan   = planOf(sub);
          const status = mapStatus(sub.status);

          const { data: gravada } = await supabaseAdmin
            .from("subscriptions").select("stripe_subscription_id").eq("workspace_id", wsId).maybeSingle();

          await updateSubscription(wsId, {
            ...(status ? { status } : {}),
            plan,
            /* O portal novo agenda o cancelamento em cancel_at, sem marcar cancel_at_period_end */
            cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at !== null,
            stripe_price_id:      sub.items.data[0]?.price.id,
            /* Pausa da cobrança (EQZ-07): some quando o Stripe volta a cobrar */
            paused_until: sub.pause_collection?.resumes_at ? new Date(sub.pause_collection.resumes_at * 1000).toISOString() : null,
            ...periodEnd(sub),
          });
          if (status === "active") await updateWorkspacePlan(wsId, plan);
          await avisarMudancaNaAssinatura(
            wsId, sub, event.data.previous_attributes as Partial<Stripe.Subscription> | undefined,
            gravada?.stripe_subscription_id, fastify.log,
          );

          fastify.log.info({ wsId, plan, status: sub.status }, "customer.subscription.updated");
          break;
        }

        case "customer.subscription.deleted": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          if (!wsId || !await isCurrentSubscription(wsId, sub.id)) break;

          await updateSubscription(wsId, { status: "canceled", cancel_at_period_end: false, paused_until: null });
          fastify.log.info({ wsId, subId: sub.id }, "customer.subscription.deleted → canceled");
          break;
        }
      }
    } catch (err) {
      /* 500 faz o Stripe reenviar o evento (com intervalos, por até 3 dias) em vez de perdê-lo */
      fastify.log.error({ err, eventId: event.id, type: event.type }, "Erro ao processar webhook Stripe");
      return reply.status(500).send({ error: "Falha ao processar o evento" });
    }

    return reply.send({ received: true });
  });
};

export default webhookRoutes;
