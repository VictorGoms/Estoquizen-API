import type { FastifyPluginAsync } from "fastify";
import Stripe from "stripe";
import { stripe, PRICE_IDS } from "../lib/stripe.js";
import { supabaseAdmin } from "../lib/supabase.js";

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

          await updateSubscription(wsId, {
            status: "active",
            plan,
            ...(custId ? { stripe_customer_id: custId } : {}),
            ...(subId  ? { stripe_subscription_id: subId } : {}),
          });
          await updateWorkspacePlan(wsId, plan);

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
          if (!wsId) break;

          await updateSubscription(wsId, { status: "past_due" });
          fastify.log.info({ wsId, subId }, "invoice.payment_failed → past_due");
          break;
        }

        case "customer.subscription.updated": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          if (!wsId) break;

          const plan   = planOf(sub);
          const status = mapStatus(sub.status);

          await updateSubscription(wsId, {
            ...(status ? { status } : {}),
            plan,
            /* O portal novo agenda o cancelamento em cancel_at, sem marcar cancel_at_period_end */
            cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at !== null,
            stripe_price_id:      sub.items.data[0]?.price.id,
            ...periodEnd(sub),
          });
          if (status === "active") await updateWorkspacePlan(wsId, plan);

          fastify.log.info({ wsId, plan, status: sub.status }, "customer.subscription.updated");
          break;
        }

        case "customer.subscription.deleted": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          if (!wsId) break;

          await updateSubscription(wsId, { status: "canceled" });
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
