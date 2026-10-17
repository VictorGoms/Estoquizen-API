import type { FastifyPluginAsync } from "fastify";
import { stripe, PRICE_IDS } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok, fail, dbError } from "../../lib/response.js";
import { requireMember } from "../../lib/membership.js";

const OWNER_ONLY = "Só o owner do workspace pode gerenciar a assinatura.";

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [fastify.authenticate] };

  /* GET /billing/subscription?workspace_id=xxx */
  fastify.get("/billing/subscription", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply)) return;

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (error) return reply.status(500).send(fail(dbError(error)));
    if (!data)  return reply.status(404).send(fail("Assinatura não encontrada"));

    return reply.send(ok(data));
  });

  /* POST /billing/checkout — cria Stripe Checkout Session */
  fastify.post("/billing/checkout", auth, async (req, reply) => {
    const { workspace_id, plan } = req.body as { workspace_id?: string; plan?: string };
    if (!workspace_id || !plan) return reply.status(400).send(fail("workspace_id e plan são obrigatórios"));
    if (!["basic", "growth", "pro"].includes(plan)) return reply.status(400).send(fail("Plano inválido"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const priceId = PRICE_IDS[plan];
    if (!priceId) return reply.status(500).send(fail("Price ID não configurado para este plano"));

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("name")
      .eq("id", workspace_id)
      .single();

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();

    /* Cria ou reutiliza Stripe Customer */
    let customerId = sub?.stripe_customer_id ?? null;
    if (!customerId) {
      const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
      const customer = await stripe.customers.create({
        email:    user?.email,
        name:     ws?.name,
        metadata: { workspace_id, user_id: req.user.id },
      });
      customerId = customer.id;

      await supabaseAdmin
        .from("subscriptions")
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspace_id);
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/select-workspace?checkout=success`,
      cancel_url:  `${siteUrl}/select-workspace?checkout=canceled`,
      subscription_data: {
        metadata: { workspace_id, plan },
      },
      metadata: { workspace_id, plan },
    });

    return reply.send(ok({ url: session.url }));
  });

  /* POST /billing/portal — Customer Portal para gerenciar assinatura */
  fastify.post("/billing/portal", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return reply.status(400).send(fail("Nenhuma assinatura ativa. Assine um plano primeiro."));
    }

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();

    const session = await stripe.billingPortal.sessions.create({
      customer:   sub.stripe_customer_id,
      return_url: `${siteUrl}/dashboard`,
    });

    return reply.send(ok({ url: session.url }));
  });
};

export default billingRoutes;
