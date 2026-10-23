import type { FastifyPluginAsync } from "fastify";
import { stripe, PRICE_IDS } from "../../lib/stripe.js";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { requireMember } from "../../lib/membership.js";
import { expireTrialIfDue } from "../../lib/checkSubscription.js";
import { pausaEmAndamento, somarMeses } from "../../lib/pausa.js";
import { getLimits } from "../../lib/plans.js";
import { CancelFeedbackSchema } from "../../schemas/billing.schema.js";
import { sendPauseScheduledEmail, sendWithdrawalEmail, sendManualRefundEmail, CONTATO } from "../../lib/resend.js";
import { prazoDaDesistencia, totalPago, caminhoDaDesistencia, type FaturaPaga } from "../../lib/desistencia.js";
import { createHash } from "node:crypto";

const OWNER_ONLY = "Só o owner do workspace pode gerenciar a assinatura.";

/* EQZ-07 (ajuste de 2026-10-20): a pessoa usa até o fim do mês já pago; depois o workspace fica
   bloqueado por 1 ou 2 meses e as mensalidades desse período são anuladas. O Stripe volta a cobrar
   2 dias depois da última mensalidade pulada (folga para a fatura já ter sido criada e anulada),
   e a cobrança seguinte, no fim da pausa, libera o acesso. Uma pausa por vez */
const PAUSA_FOLGA_S = 2 * 24 * 60 * 60;

/* O Stripe não tem mais o objeto (apagado, ou de outra conta/área restrita) */
const stripeMissing = (err: unknown) => (err as { code?: string } | null)?.code === "resource_missing";

/* Faturas pagas (com valor) da assinatura, para a desistência (EQZ-50) */
async function faturasPagas(subscriptionId: string): Promise<FaturaPaga[]> {
  const lista = await stripe.invoices.list({ subscription: subscriptionId, status: "paid", limit: 100 });
  return lista.data
    .filter((f) => f.amount_paid > 0 && f.status_transitions.paid_at)
    .map((f) => ({ id: f.id, valor: f.amount_paid, pagaEm: f.status_transitions.paid_at! }));
}

const dataBR = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/* A pessoa já desistiu pelo app antes? Pelo usuário e pelo CPF codificado, o mesmo SHA-256 do
   trial_grants (EQZ-50, tabela desistencias: 1 vez por pessoa pelo app) */
async function desistiuAntes(userId: string): Promise<{ jaDesistiu: boolean; cpfHash: string | null }> {
  const { data: perfil, error: erroPerfil } = await supabaseAdmin.from("profiles").select("cpf").eq("id", userId).maybeSingle();
  if (erroPerfil) throw erroPerfil;
  const cpfHash  = perfil?.cpf ? createHash("sha256").update(perfil.cpf).digest("hex") : null;
  const consulta = supabaseAdmin.from("desistencias").select("id", { count: "exact", head: true });
  const { count, error } = await (cpfHash ? consulta.or(`user_id.eq.${userId},cpf_hash.eq.${cpfHash}`) : consulta.eq("user_id", userId));
  if (error) throw error;
  return { jaDesistiu: (count ?? 0) > 0, cpfHash };
}

const JA_DESISTIU = `Você já usou a desistência pelo app uma vez. Para pedir de novo, escreva para ${CONTATO}: respondemos em até 1 dia útil.`;

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

    /* EQZ-07: a tela não calcula datas na renderização, então a API diz se a pausa está em
       andamento (workspace bloqueado), se está agendada (ainda no mês pago) e se dá para pausar */
    const agora          = Date.now();
    const pausada        = pausaEmAndamento(data, agora);
    const pausaAgendada  = !!data.pause_starts_at && agora < new Date(data.pause_starts_at).getTime();
    const pausaDisponivel = data.status === "active" && !!data.stripe_subscription_id && !data.cancel_at_period_end
      && !pausada && !pausaAgendada;

    return reply.send(ok({ ...data, pausada, pausa_agendada: pausaAgendada, pausa_disponivel: pausaDisponivel }));
  });

  /* POST /billing/checkout — cria Stripe Checkout Session. Com { embutido: true } o pagamento
     aparece dentro do app (ui_mode embedded_page) e a resposta traz o client_secret; sem, devolve a
     url da página do Stripe. Troca de plano de quem já paga continua pelo portal (url). */
  fastify.post("/billing/checkout", auth, async (req, reply) => {
    const { workspace_id, plan, embutido = false } = req.body as { workspace_id?: string; plan?: string; embutido?: boolean };
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

    const comum = {
      customer:   customerId,
      mode:       "subscription" as const,
      locale:     "pt-BR" as const,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { workspace_id, plan } },
      metadata: { workspace_id, plan },
    };

    if (embutido) {
      /* Cartão não precisa sair da página: o app recebe o onComplete e espera o webhook ativar.
         O return_url só é usado por meio de pagamento que redireciona */
      const session = await stripe.checkout.sessions.create({
        ...comum,
        ui_mode:                "embedded_page",
        redirect_on_completion: "if_required",
        return_url:             `${siteUrl}/select-workspace?checkout=success`,
      });
      return reply.send(ok({ client_secret: session.client_secret }));
    }

    const session = await stripe.checkout.sessions.create({
      ...comum,
      success_url: `${siteUrl}/select-workspace?checkout=success`,
      cancel_url:  `${siteUrl}/select-workspace?checkout=canceled`,
    });

    return reply.send(ok({ url: session.url }));
  });

  /* POST /billing/portal — Customer Portal do Stripe para cartão, faturas e troca de plano.
     Cancelar não passa mais por aqui (desligado no portal desde 2026-10-20): é no app, por
     POST /billing/cancel, depois da pergunta do cancelamento. Excluir o workspace é outra coisa:
     DELETE /workspaces/:id. */
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

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer:   sub.stripe_customer_id,
        locale:     "pt-BR",
        return_url: `${siteUrl}/configuracoes`,
      });
      return reply.send(ok({ url: session.url }));
    } catch (err) {
      req.log.error({ err, workspace_id }, "falha ao abrir o portal do Stripe");
      return reply.status(502).send(fail("Não foi possível abrir o portal de cobrança. Tente novamente."));
    }
  });

  /* POST /billing/cancel — cancela no fim do ciclo pago, direto no app (EQZ-07). A pessoa usa até
     lá; depois o workspace fica bloqueado e os dados ficam 30 dias. Uma pausa agendada é desfeita
     (o cancelamento vem antes dela). O e-mail "Cancelamento agendado" sai pelo webhook */
  fastify.post("/billing/cancel", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status, cancel_at_period_end, pause_ends_at")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || !["active", "past_due"].includes(sub.status)) {
      return reply.status(400).send(fail("Não há assinatura paga para cancelar."));
    }
    if (sub.cancel_at_period_end) {
      return reply.status(409).send(fail("O cancelamento já está agendado para o fim do ciclo."));
    }
    const tinhaPausa = !!sub.pause_ends_at && new Date(sub.pause_ends_at) > new Date();

    try {
      const atualizada = await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
        ...(tinhaPausa ? { pause_collection: "" as const } : {}),
      });
      const fimPago = atualizada.items.data[0]?.current_period_end;
      const { error } = await supabaseAdmin
        .from("subscriptions")
        .update({
          cancel_at_period_end: true,
          ...(tinhaPausa ? { paused_until: null, pause_starts_at: null, pause_ends_at: null, pause_reminder_sent_at: null } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspace_id);
      if (error) req.log.error({ err: error, workspace_id }, "cancelado no Stripe, mas não gravou no banco (o webhook acerta)");
      return reply.send(ok({ acesso_ate: fimPago ? new Date(fimPago * 1000).toISOString() : null }));
    } catch (err) {
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao cancelar no Stripe");
      return reply.status(502).send(fail("Não foi possível cancelar. Tente novamente."));
    }
  });

  /* POST /billing/uncancel — desfaz o cancelamento agendado (a assinatura segue renovando) */
  fastify.post("/billing/uncancel", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status, cancel_at_period_end")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || !["active", "past_due"].includes(sub.status) || !sub.cancel_at_period_end) {
      return reply.status(409).send(fail("Não há cancelamento agendado para desfazer."));
    }

    try {
      /* O portal antigo agendava por cancel_at; o app, por cancel_at_period_end. O Stripe não aceita
         os dois juntos, então desfaz o que estiver marcado */
      const atual = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      await stripe.subscriptions.update(sub.stripe_subscription_id, atual.cancel_at && !atual.cancel_at_period_end
        ? { cancel_at: "" }
        : { cancel_at_period_end: false });
    } catch (err) {
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao desfazer o cancelamento no Stripe");
      return reply.status(502).send(fail("Não foi possível desfazer o cancelamento. Tente novamente."));
    }

    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({ cancel_at_period_end: false, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspace_id);
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok({ desfeito: true }));
  });

  /* GET /billing/desistencia?workspace_id=xxx — dá para desistir com o valor de volta (EQZ-50)?
     Até quando (7 dias do 1º pagamento da assinatura), quanto volta, em centavos, e por onde:
     disponivel (pelo app) ou pelo_contato (a pessoa já desistiu pelo app antes) */
  fastify.get("/billing/desistencia", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    const nada = { disponivel: false, pelo_contato: false, ate: null, valor: 0 };
    if (!sub?.stripe_subscription_id || !["active", "past_due"].includes(sub.status)) return reply.send(ok(nada));

    try {
      const faturas = await faturasPagas(sub.stripe_subscription_id);
      const prazo   = prazoDaDesistencia(faturas);
      if (!prazo || Date.now() > prazo) return reply.send(ok(nada));
      /* Sem conseguir conferir, manda pelo contato@: o direito continua, só não é automático */
      const jaDesistiu = await desistiuAntes(req.user.id).then((r) => r.jaDesistiu).catch((err) => {
        req.log.error({ err, workspace_id }, "falha ao conferir desistências anteriores");
        return true;
      });
      const caminho = caminhoDaDesistencia(prazo, Date.now(), jaDesistiu);
      return reply.send(ok({
        disponivel: caminho === "app", pelo_contato: caminho === "contato",
        ate: new Date(prazo).toISOString(), valor: totalPago(faturas),
      }));
    } catch (err) {
      if (stripeMissing(err)) return reply.send(ok(nada));
      req.log.error({ err, workspace_id }, "falha ao ler as faturas para a desistência");
      return reply.status(502).send(fail("Não foi possível consultar o prazo de desistência."));
    }
  });

  /* POST /billing/desistir — desistência em até 7 dias do 1º pagamento (EQZ-50): devolve tudo o que a
     assinatura pagou e cancela na hora. O workspace fica bloqueado e os dados ficam 30 dias, como num
     cancelamento. Repetir é seguro: pagamento já devolvido é pulado. O que o Stripe não devolve
     (boleto não tem estorno) fica para devolver à mão, com aviso ao contato@ */
  fastify.post("/billing/desistir", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || !["active", "past_due"].includes(sub.status)) {
      return reply.status(400).send(fail("Não há assinatura paga para desistir."));
    }

    let faturas: FaturaPaga[];
    try {
      faturas = await faturasPagas(sub.stripe_subscription_id);
    } catch (err) {
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao ler as faturas para a desistência");
      return reply.status(502).send(fail("Não foi possível desistir agora. Tente novamente."));
    }
    const prazo = prazoDaDesistencia(faturas);
    if (!prazo) return reply.status(409).send(fail("Esta assinatura ainda não teve pagamento para devolver."));
    if (Date.now() > prazo) {
      return reply.status(409).send(fail(`O prazo de 7 dias para desistir acabou em ${dataBR(prazo)}. Você ainda pode cancelar: o acesso vai até o fim do mês pago.`));
    }

    /* Pelo app, 1 vez por pessoa; da 2ª em diante, pelo contato@ */
    let cpfHash: string | null;
    try {
      const antes = await desistiuAntes(req.user.id);
      if (antes.jaDesistiu) return reply.status(409).send(fail(JA_DESISTIU));
      cpfHash = antes.cpfHash;
    } catch (err) {
      req.log.error({ err, workspace_id }, "falha ao conferir desistências anteriores");
      return reply.status(502).send(fail("Não foi possível desistir agora. Tente novamente."));
    }

    /* 1) Devolve cada pagamento das faturas. Sem PaymentIntent ou recusado pelo Stripe: à mão */
    let devolvido = 0;
    const manuais: { fatura: string; valor: number; motivo: string }[] = [];
    try {
      for (const f of faturas) {
        const pagamentos = await stripe.invoicePayments.list({ invoice: f.id, status: "paid" });
        for (const p of pagamentos.data) {
          const pi    = p.payment.payment_intent;
          const piId  = typeof pi === "string" ? pi : pi?.id;
          const valor = p.amount_paid ?? 0;
          if (!piId) { manuais.push({ fatura: f.id, valor, motivo: `pagamento do tipo ${p.payment.type}` }); continue; }
          try {
            const estorno = await stripe.refunds.create({
              payment_intent: piId,
              reason:         "requested_by_customer",
              metadata:       { workspace_id, motivo: "desistencia_7_dias" },
            });
            devolvido += estorno.amount;
          } catch (err) {
            /* Já devolvido (pedido repetido): conta como devolvido */
            if ((err as { code?: string }).code === "charge_already_refunded") { devolvido += valor; continue; }
            manuais.push({ fatura: f.id, valor, motivo: (err as Error).message });
          }
        }
      }
    } catch (err) {
      req.log.error({ err, workspace_id, devolvido }, "falha ao devolver os pagamentos da desistência");
      return reply.status(502).send(fail("Não foi possível concluir a devolução. Tente novamente: o que já foi devolvido não é cobrado de novo."));
    }

    /* 2) Cancela na hora, sem fatura de acerto */
    try {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id, {
        prorate: false,
        cancellation_details: { comment: "Desistência em 7 dias (CDC art. 49), pelo app" },
      });
    } catch (err) {
      if (!stripeMissing(err)) {
        req.log.error({ err, workspace_id, devolvido }, "devolveu, mas não cancelou a assinatura no Stripe");
        return reply.status(502).send(fail("O valor foi devolvido, mas não deu para encerrar a assinatura. Tente de novo em instantes."));
      }
    }

    /* 3) Bloqueia já (o webhook customer.subscription.deleted grava o mesmo depois) */
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({
        status: "canceled", cancel_at_period_end: false,
        paused_until: null, pause_starts_at: null, pause_ends_at: null, pause_reminder_sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspace_id);
    if (error) req.log.error({ err: error, workspace_id }, "desistência feita no Stripe, mas não gravou no banco (o webhook acerta)");

    /* 4) Registra para a regra de 1 vez por pessoa. Só depois de cancelar: se o cancelamento falhar,
       a pessoa tenta de novo sem esbarrar na regra */
    const manual = manuais.reduce((soma, m) => soma + m.valor, 0);
    const { error: erroRegistro } = await supabaseAdmin.from("desistencias").insert({
      user_id: req.user.id, cpf_hash: cpfHash, workspace_id, stripe_subscription_id: sub.stripe_subscription_id, devolvido, manual,
    });
    if (erroRegistro) req.log.error({ err: erroRegistro, workspace_id }, "desistência feita, mas não gravou em desistencias (a regra de 1 vez não vai valer para ela)");

    /* 5) E-mails: confirmação ao dono (o decreto pede confirmação imediata) e, se faltou devolver
       algo, aviso ao contato@. Falha no e-mail só vai para o log: a desistência já valeu */
    try {
      const { data: ws } = await supabaseAdmin.from("workspaces").select("name, created_by").eq("id", workspace_id).maybeSingle();
      const { data: dono } = ws
        ? await supabaseAdmin.from("profiles").select("email").eq("id", ws.created_by).maybeSingle()
        : { data: null };
      if (ws && dono?.email) await sendWithdrawalEmail({ to: dono.email, workspaceName: ws.name, devolvido, manual });
      if (manuais.length) {
        await sendManualRefundEmail({ workspaceId: workspace_id, workspaceName: ws?.name ?? workspace_id, donoEmail: dono?.email ?? null, manuais });
      }
    } catch (err) {
      req.log.error({ err, workspace_id, manuais }, "desistência feita, mas um e-mail falhou");
    }

    return reply.send(ok({ devolvido, manual }));
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

  /* POST /billing/pause { meses: 1 | 2 } — pausa em vez de cancelar (EQZ-07). A pessoa usa até o
     fim do mês já pago; depois o workspace fica bloqueado pelos meses escolhidos e as mensalidades
     desse período são anuladas (pause_collection do Stripe, behavior "void"). A cobrança seguinte,
     no fim da pausa, devolve o acesso. Dá para desfazer antes de começar ou retomar no meio
     (POST /billing/resume) */
  fastify.post("/billing/pause", auth, async (req, reply) => {
    const { workspace_id, meses = 1 } = req.body as { workspace_id?: string; meses?: number };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));
    if (meses !== 1 && meses !== 2) return reply.status(400).send(fail("A pausa é de 1 ou 2 meses."));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, status, plan, cancel_at_period_end, pause_starts_at, pause_ends_at")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || sub.status !== "active") {
      return reply.status(400).send(fail("Só dá para pausar uma assinatura paga e em dia."));
    }
    if (sub.cancel_at_period_end) {
      return reply.status(409).send(fail("A assinatura já está com cancelamento agendado."));
    }
    if (sub.pause_ends_at && new Date(sub.pause_ends_at) > new Date()) {
      return reply.status(409).send(fail("Já existe uma pausa agendada ou em andamento."));
    }

    try {
      const atual = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const fimPago = atual.items.data[0]?.current_period_end;
      if (!fimPago || fimPago * 1000 <= Date.now()) {
        return reply.status(409).send(fail("Não foi possível achar a próxima mensalidade. Tente de novo em instantes."));
      }
      /* Mensalidades puladas: as que vencem em fimPago, fimPago + 1 mês, ... (meses no total) */
      const voltaCobranca = somarMeses(fimPago, meses - 1) + PAUSA_FOLGA_S;
      const fimDaPausa    = somarMeses(fimPago, meses);

      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        pause_collection: { behavior: "void", resumes_at: voltaCobranca },
      });

      const campos = {
        paused_until:    new Date(voltaCobranca * 1000).toISOString(),
        pause_starts_at: new Date(fimPago * 1000).toISOString(),
        pause_ends_at:   new Date(fimDaPausa * 1000).toISOString(),
        last_paused_at:  new Date().toISOString(),
        pause_reminder_sent_at: null,
        updated_at:      new Date().toISOString(),
      };
      const { error } = await supabaseAdmin.from("subscriptions").update(campos).eq("workspace_id", workspace_id);
      if (error) {
        req.log.error({ err: error, workspace_id }, "pausa feita no Stripe, mas não gravou no banco");
        return reply.status(500).send(fail("A pausa foi feita, mas não deu para registrar. Fale com o suporte."));
      }

      /* E-mail "Pausa agendada" para o dono; se falhar, só vai para o log (a pausa já valeu) */
      try {
        const { data: ws } = await supabaseAdmin.from("workspaces").select("name, created_by").eq("id", workspace_id).maybeSingle();
        const { data: dono } = ws
          ? await supabaseAdmin.from("profiles").select("email").eq("id", ws.created_by).maybeSingle()
          : { data: null };
        if (ws && dono?.email) {
          await sendPauseScheduledEmail({
            to: dono.email, workspaceName: ws.name, meses,
            inicio: new Date(fimPago * 1000), fim: new Date(fimDaPausa * 1000), mensal: getLimits(sub.plan).price,
          });
        }
      } catch (err) {
        req.log.error({ err, workspace_id }, "pausa feita, mas o e-mail de pausa agendada falhou");
      }

      return reply.send(ok({ pause_starts_at: campos.pause_starts_at, pause_ends_at: campos.pause_ends_at }));
    } catch (err) {
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao pausar a cobrança no Stripe");
      return reply.status(502).send(fail("Não foi possível pausar. Tente novamente."));
    }
  });

  /* POST /billing/resume — desfaz a pausa. Antes de ela começar, só tira a pausa (a cobrança segue
     como antes). Com ela em andamento, cobra agora uma mensalidade, começa um ciclo novo e libera o
     acesso na hora; se o cartão recusar, nada muda */
  fastify.post("/billing/resume", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner"], OWNER_ONLY)) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id, pause_starts_at, pause_ends_at")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    if (!sub?.stripe_subscription_id || !sub.pause_ends_at || new Date(sub.pause_ends_at) <= new Date()) {
      return reply.status(409).send(fail("Não há pausa para desfazer."));
    }
    const emAndamento = pausaEmAndamento(sub);

    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, emAndamento
        ? { pause_collection: "", billing_cycle_anchor: "now", proration_behavior: "none", payment_behavior: "error_if_incomplete" }
        : { pause_collection: "" });
    } catch (err) {
      const codigo = (err as { code?: string; type?: string } | null);
      if (codigo?.type === "StripeCardError" || codigo?.code === "card_declined") {
        return reply.status(402).send(fail("O cartão recusou a cobrança. Atualize o cartão em \"Gerenciar assinatura e pagamento\" e tente de novo."));
      }
      if (stripeMissing(err)) return reply.status(409).send(fail("A assinatura não foi encontrada no Stripe."));
      req.log.error({ err, workspace_id }, "falha ao retomar a assinatura no Stripe");
      return reply.status(502).send(fail("Não foi possível retomar. Tente novamente."));
    }

    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({ paused_until: null, pause_starts_at: null, pause_ends_at: null, pause_reminder_sent_at: null, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspace_id);
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok({ retomada: true, cobrou_agora: emAndamento }));
  });
};

export default billingRoutes;
