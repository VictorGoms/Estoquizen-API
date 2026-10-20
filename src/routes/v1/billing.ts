import type { FastifyPluginAsync } from "fastify";
import { stripe, PRICE_IDS } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { requireMember } from "../../lib/membership.js";
import { expireTrialIfDue } from "../../lib/checkSubscription.js";

const OWNER_ONLY = "Só o owner do workspace pode gerenciar a assinatura.";

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [fastify.authenticate] };

  /* GET /billing/subscription?workspace_id=xxx */
  fastify.get("/billing/subscription", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply)) return;

    /* Trial vencido aparece como vencido mesmo se o job diário ainda não rodou */
    await expireTrialIfDue(workspace_id).catch((err) => req.log.error({ err, workspace_id }, "falha ao expirar o trial"));

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (error) return sendDbError(req, reply, error);
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
      .select("stripe_customer_id, stripe_subscription_id, status")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();

    /* Quem já paga troca de plano na assinatura atual, pela tela de confirmação do portal (mostra o
       valor proporcional). Um checkout novo criaria uma segunda assinatura e cobraria duas vezes. */
    if (sub?.stripe_subscription_id && ["active", "past_due"].includes(sub.status)) {
      try {
        const current = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const item    = current.items.data[0];
        if (["active", "past_due"].includes(current.status) && item) {
          if (item.price.id === priceId) return reply.status(409).send(fail("Este já é o plano atual."));

          const portal = await stripe.billingPortal.sessions.create({
            customer:   typeof current.customer === "string" ? current.customer : current.customer.id,
            locale:     "pt-BR",
            return_url: `${siteUrl}/configuracoes`,
            flow_data: {
              type: "subscription_update_confirm",
              subscription_update_confirm: {
                subscription: current.id,
                items: [{ id: item.id, price: priceId, quantity: 1 }],
              },
              after_completion: {
                type:     "redirect",
                redirect: { return_url: `${siteUrl}/configuracoes?plano=atualizado` },
              },
            },
          });
          return reply.send(ok({ url: portal.url }));
        }
      } catch (err) {
        req.log.error({ err, workspace_id }, "falha ao abrir a troca de plano no portal");
        return reply.status(502).send(fail("Não foi possível abrir a troca de plano. Tente novamente."));
      }
    }

    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("name")
      .eq("id", workspace_id)
      .single();

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
      locale:     "pt-BR",
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

  /* POST /billing/portal — Customer Portal para gerenciar assinatura.
     Com { flow: "cancel" } abre direto a tela de cancelamento, que vale no fim do ciclo pago
     (o portal está em at_period_end). Excluir o workspace é outra coisa: DELETE /workspaces/:id. */
  fastify.post("/billing/portal", auth, async (req, reply) => {
    const { workspace_id, flow } = req.body as { workspace_id?: string; flow?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));
    if (flow !== undefined && flow !== "cancel") return reply.status(400).send(fail("flow inválido"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id, stripe_subscription_id, status, cancel_at_period_end")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return reply.status(400).send(fail("Nenhuma assinatura ativa. Assine um plano primeiro."));
    }

    if (flow === "cancel") {
      if (!sub.stripe_subscription_id || !["active", "past_due"].includes(sub.status)) {
        return reply.status(400).send(fail("Não há assinatura paga para cancelar."));
      }
      if (sub.cancel_at_period_end) {
        return reply.status(409).send(fail("O cancelamento já está agendado para o fim do ciclo."));
      }
    }

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer:   sub.stripe_customer_id,
        locale:     "pt-BR",
        return_url: flow === "cancel" ? `${siteUrl}/configuracoes` : `${siteUrl}/dashboard`,
        ...(flow === "cancel" && {
          flow_data: {
            type: "subscription_cancel",
            subscription_cancel: { subscription: sub.stripe_subscription_id! },
            after_completion: {
              type:     "redirect",
              redirect: { return_url: `${siteUrl}/configuracoes?assinatura=cancelada` },
            },
          },
        }),
      });
      return reply.send(ok({ url: session.url }));
    } catch (err) {
      req.log.error({ err, workspace_id, flow }, "falha ao abrir o portal do Stripe");
      return reply.status(502).send(fail("Não foi possível abrir o portal de cobrança. Tente novamente."));
    }
  });
};

export default billingRoutes;
