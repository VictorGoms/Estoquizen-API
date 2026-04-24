import type { FastifyPluginAsync } from "fastify";
import Stripe from "stripe";
import { stripe } from "../lib/stripe.js";
import { supabaseAdmin } from "../lib/supabase.js";

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

          const subId     = typeof session.subscription === "string" ? session.subscription : (session.subscription as any)?.id;
          const custId    = typeof session.customer     === "string" ? session.customer     : (session.customer as any)?.id;

          const updatePayload: Record<string, unknown> = {
            status:            "active",
            plan,
            stripe_customer_id: custId ?? undefined,
            updated_at:         new Date().toISOString(),
          };
          if (subId) updatePayload.stripe_subscription_id = subId;

          await supabaseAdmin.from("subscriptions").update(updatePayload).eq("workspace_id", wsId);
          await supabaseAdmin.from("workspaces").update({ plan, updated_at: new Date().toISOString() }).eq("id", wsId);

          fastify.log.info({ wsId, plan, subId }, "checkout.session.completed → assinatura ativada");
          break;
        }

        case "invoice.paid": {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const invoice = event.data.object as any;
          const subId: string | undefined = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
          if (!subId) break;

          const sub  = await stripe.subscriptions.retrieve(subId);
          const wsId = sub.metadata?.workspace_id;
          const plan = sub.metadata?.plan ?? "basic";
          if (!wsId) break;

          await supabaseAdmin.from("subscriptions").update({
            status:                 "active",
            plan,
            stripe_subscription_id: subId,
            stripe_customer_id:     typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
            stripe_price_id:        sub.items.data[0]?.price.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            current_period_end:     new Date((sub as any).current_period_end * 1000).toISOString(),
            updated_at:             new Date().toISOString(),
          }).eq("workspace_id", wsId);

          await supabaseAdmin.from("workspaces").update({
            plan,
            updated_at: new Date().toISOString(),
          }).eq("id", wsId);

          fastify.log.info({ wsId, plan, subId }, "invoice.paid → assinatura ativada");
          break;
        }

        case "invoice.payment_failed": {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const invoice = event.data.object as any;
          const subId: string | undefined = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
          if (!subId) break;

          const sub  = await stripe.subscriptions.retrieve(subId);
          const wsId = sub.metadata?.workspace_id;
          if (!wsId) break;

          await supabaseAdmin.from("subscriptions").update({
            status:     "past_due",
            updated_at: new Date().toISOString(),
          }).eq("workspace_id", wsId);
          break;
        }

        case "customer.subscription.updated": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          const plan = sub.metadata?.plan ?? "basic";
          if (!wsId) break;

          await supabaseAdmin.from("subscriptions").update({
            status:               sub.status === "active" ? "active" : sub.status,
            plan,
            cancel_at_period_end: sub.cancel_at_period_end,
            stripe_price_id:      sub.items.data[0]?.price.id,
            current_period_end:   new Date((sub as any).current_period_end * 1000).toISOString(),
            updated_at:           new Date().toISOString(),
          }).eq("workspace_id", wsId);
          break;
        }

        case "customer.subscription.deleted": {
          const sub  = event.data.object as Stripe.Subscription;
          const wsId = sub.metadata?.workspace_id;
          if (!wsId) break;

          await supabaseAdmin.from("subscriptions").update({
            status:     "canceled",
            updated_at: new Date().toISOString(),
          }).eq("workspace_id", wsId);
          break;
        }
      }
    } catch (err) {
      fastify.log.error(err, "Erro ao processar webhook Stripe");
    }

    return reply.send({ received: true });
  });
};

export default webhookRoutes;
