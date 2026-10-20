import type { FastifyPluginAsync } from "fastify";
import { stripe, PRICE_IDS } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { requireMember } from "../../lib/membership.js";
import { expireTrialIfDue } from "../../lib/checkSubscription.js";
import { getLimits } from "../../lib/plans.js";
import { CancelFeedbackSchema } from "../../schemas/billing.schema.js";

const OWNER_ONLY = "Só o owner do workspace pode gerenciar a assinatura.";

const DIA_MS = 24 * 60 * 60 * 1000;
/* EQZ-07: a pausa anula a mensalidade que vence no período e volta 2 dias depois dela
   (folga para a fatura da renovação já ter sido criada e anulada). 1 pausa por ano */
const PAUSA_FOLGA_DIAS   = 2;
const PAUSA_INTERVALO_MS = 365 * DIA_MS;

/* O Stripe não tem mais o objeto (apagado, ou de outra conta/área restrita) */
const stripeMissing = (err: unknown) => (err as { code?: string } | null)?.code === "resource_missing";

/**
 * Mudar para um plano só se o uso couber nele. Sem isso, quem tem 120 produtos desceria para o
 * Basic e seguiria usando os 120 pagando menos (o banco só barra cadastro novo). Retorna o motivo
 * ou null. Membros contam ativos + convites pendentes, como em POST /members/invite.
 */
async function usoAcimaDoPlano(workspaceId: string, plan: string): Promise<string | null> {
  const limits = getLimits(plan);
  const [{ count: produtos }, { count: membros }] = await Promise.all([
    supabaseAdmin.from("products").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    supabaseAdmin.from("workspace_members").select("user_id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).in("status", ["ativo", "pendente"]),
  ]);
  const motivos: string[] = [];
  if ((produtos ?? 0) > limits.products) {
    motivos.push(`Você tem ${produtos} produtos e o ${limits.label} vai até ${limits.products}: remova ${(produtos ?? 0) - limits.products} antes de mudar.`);
  }
  if ((membros ?? 0) > limits.members) {
    motivos.push(`A equipe tem ${membros} pessoas (com convites pendentes) e o ${limits.label} vai até ${limits.members}: remova ${(membros ?? 0) - limits.members} antes de mudar.`);
  }
  return motivos.length ? motivos.join(" ") : null;
}

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

    /* EQZ-07: a tela não calcula datas na renderização, então a API diz se a cobrança está
       pausada e se a pausa (1 por ano, só assinatura paga em dia) ainda pode ser usada */
    const agora    = Date.now();
    const pausada  = !!data.paused_until && new Date(data.paused_until).getTime() > agora;
    const pausaDisponivel = data.status === "active" && !!data.stripe_subscription_id && !data.cancel_at_period_end && !pausada
      && (!data.last_paused_at || agora - new Date(data.last_paused_at).getTime() >= PAUSA_INTERVALO_MS);

    return reply.send(ok({ ...data, pausada, pausa_disponivel: pausaDisponivel }));
  });

  /* POST /billing/checkout — cria Stripe Checkout Session */
  fastify.post("/billing/checkout", auth, async (req, reply) => {
    const { workspace_id, plan } = req.body as { workspace_id?: string; plan?: string };
    if (!workspace_id || !plan) return reply.status(400).send(fail("workspace_id e plan são obrigatórios"));
    if (!["basic", "growth", "pro"].includes(plan)) return reply.status(400).send(fail("Plano inválido"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const priceId = PRICE_IDS[plan];
    if (!priceId) return reply.status(500).send(fail("Price ID não configurado para este plano"));

    const acima = await usoAcimaDoPlano(workspace_id, plan);
    if (acima) return reply.status(409).send(fail(acima));

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
        /* Assinatura gravada que não existe mais no Stripe (ex.: dado de teste antigo): segue para o checkout */
        if (!stripeMissing(err)) {
          req.log.error({ err, workspace_id }, "falha ao abrir a troca de plano no portal");
          return reply.status(502).send(fail("Não foi possível abrir a troca de plano. Tente novamente."));
        }
        req.log.warn({ workspace_id }, "assinatura gravada não existe no Stripe; abrindo checkout novo");
      }
    }

    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("name")
      .eq("id", workspace_id)
      .single();

    /* Cria ou reutiliza Stripe Customer (o gravado pode ter sido apagado no Stripe) */
    let customerId = sub?.stripe_customer_id ?? null;
    if (customerId) {
      const existing = await stripe.customers.retrieve(customerId).catch((err) => {
        if (stripeMissing(err)) return null;
        throw err;
      });
      if (!existing || existing.deleted) customerId = null;
    }
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

  /* POST /billing/cancel-feedback — a resposta da única pergunta do cancelamento (EQZ-07) e o que a
     pessoa fez depois (cancelar, pausar ou trocar de plano). O front manda antes de agir; falhar
     aqui não impede a ação */
  fastify.post("/billing/cancel-feedback", auth, async (req, reply) => {
    const parsed = CancelFeedbackSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));
    const { workspace_id, motivo, detalhe, acao } = parsed.data;

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: ws } = await supabaseAdmin.from("workspaces").select("plan").eq("id", workspace_id).maybeSingle();
    const { error } = await supabaseAdmin.from("cancel_feedback").insert({
      workspace_id, user_id: req.user.id, plan: ws?.plan ?? null, motivo, detalhe: detalhe || null, acao,
    });
    if (error) return sendDbError(req, reply, error);
    return reply.status(201).send(ok(null));
  });

  /* POST /billing/pause — pausa a cobrança por 1 mês em vez de cancelar (EQZ-07). Usa o
     pause_collection do Stripe com faturas anuladas: a assinatura continua ativa, o acesso também,
     e a mensalidade que vence no período não é cobrada. A cobrança volta sozinha */
  fastify.post("/billing/pause", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status, cancel_at_period_end, paused_until, last_paused_at")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || sub.status !== "active") {
      return reply.status(400).send(fail("Só dá para pausar uma assinatura paga e em dia."));
    }
    if (sub.cancel_at_period_end) {
      return reply.status(409).send(fail("A assinatura já está com cancelamento agendado."));
    }
    if (sub.paused_until && new Date(sub.paused_until) > new Date()) {
      return reply.status(409).send(fail("A cobrança já está pausada."));
    }
    if (sub.last_paused_at && Date.now() - new Date(sub.last_paused_at).getTime() < PAUSA_INTERVALO_MS) {
      return reply.status(409).send(fail("A pausa pode ser usada uma vez por ano, e já foi usada nos últimos 12 meses."));
    }

    try {
      const atual = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const fim   = atual.items.data[0]?.current_period_end;
      if (!fim || fim * 1000 <= Date.now()) {
        return reply.status(409).send(fail("Não foi possível achar a próxima mensalidade. Tente de novo em instantes."));
      }
      const voltaEm = fim + PAUSA_FOLGA_DIAS * 24 * 60 * 60;

      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        pause_collection: { behavior: "void", resumes_at: voltaEm },
      });

      const pausedUntil = new Date(voltaEm * 1000).toISOString();
      const { error } = await supabaseAdmin
        .from("subscriptions")
        .update({ paused_until: pausedUntil, last_paused_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("workspace_id", workspace_id);
      /* O webhook customer.subscription.updated grava paused_until de novo; last_paused_at só aqui */
      if (error) req.log.error({ err: error, workspace_id }, "pausa feita no Stripe, mas não gravou no banco");

      return reply.send(ok({ paused_until: pausedUntil, mensalidade_pulada: new Date(fim * 1000).toISOString() }));
    } catch (err) {
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao pausar a cobrança no Stripe");
      return reply.status(502).send(fail("Não foi possível pausar a cobrança. Tente novamente."));
    }
  });
};

export default billingRoutes;
