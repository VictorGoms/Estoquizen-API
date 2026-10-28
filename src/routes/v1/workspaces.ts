import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema } from "../../schemas/workspace.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { assertActiveSubscription } from "../../lib/checkSubscription.js";
import { sanitizeCpf } from "../../lib/sanitize.js";
import { stripe } from "../../lib/stripe.js";
import { fimDoTeste, hashEmailDoTeste } from "../../lib/trial.js";
import { apagarFotosDoWorkspace } from "../../lib/fotos.js";
import { workspaceEsperandoPagamento, msgWorkspacePendente, testeDaConta } from "../../lib/empresaPendente.js";
import { requireMember } from "../../lib/membership.js";

const workspacesRoutes: FastifyPluginAsync = async (fastify) => {
  const auth       = { preHandler: [fastify.authenticate] };
  const authWrite  = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const authStrict = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /* GET /workspaces — workspaces do usuário autenticado */
  fastify.get("/workspaces", auth, async (req, reply) => {
    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { data, error } = await db
      .from("workspace_members")
      .select("role, status, workspaces(id, name, description, plan, segment, created_at)")
      .eq("user_id", req.user.id)
      .eq("status", "ativo");

    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /* GET /workspaces/:id/stats — contadores para o dashboard */
  fastify.get("/workspaces/:id/stats", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const token  = req.headers.authorization!.slice(7);
    const db     = supabaseForUser(token);

    const [{ data: estoque }, { count: movimentacoes }] = await Promise.all([
      db.from("products").select("qty, min_qty").eq("workspace_id", id),
      db.from("movements").select("id, products!inner(workspace_id)", { count: "exact", head: true })
        .eq("products.workspace_id", id),
    ]);

    /* Mesma regra do front (deriveStatus): alerta = zerado ou no mínimo/abaixo dele.
       Antes era qty < 10, que ignorava o mínimo de cada produto. O PostgREST não compara
       duas colunas, então a conta é feita aqui. */
    const produtos = estoque ?? [];
    const alertas  = produtos.filter((p) => Number(p.qty) <= 0 || Number(p.qty) <= Number(p.min_qty)).length;

    return reply.send(ok({ produtos: produtos.length, alertas, movimentacoes: movimentacoes ?? 0 }));
  });

  /* GET /workspaces/teste-disponivel — a escolha de plano mostra "R$ 0,00" ou avisa antes de criar (2026-10-28).
     Só pela conta: o CPF é conferido na criação, para esta rota não dizer se um CPF já foi usado */
  fastify.get("/workspaces/teste-disponivel", auth, async (req, reply) => {
    /* Disponível: a conta nunca usou (nem outra conta com o mesmo e-mail normalizado, o "+algo" do mesmo Gmail),
       ou usou num workspace já excluído e o prazo ainda vale (recomeçar, até a mesma data) */
    const emailHash = req.user.email ? hashEmailDoTeste(req.user.email) : null;
    const [conta, outra, { pendente, error: pendErr }] = await Promise.all([
      testeDaConta(req.user.id),
      emailHash
        ? supabaseAdmin.from("trial_grants").select("user_id").eq("email_hash", emailHash).neq("user_id", req.user.id).limit(1).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      workspaceEsperandoPagamento(req.user.id),
    ]);
    const error = conta.error ?? outra.error ?? pendErr;
    if (error) return sendDbError(req, reply, error);
    const disponivel = conta.recomecarAte !== null || (!conta.grant && !outra.data);
    return reply.send(ok({ disponivel, pendente }));
  });

  /* POST /workspaces — cria workspace, owner e subscription de trial */
  fastify.post("/workspaces", authStrict, async (req, reply) => {
    const parsed = CreateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    /* No máximo 1 workspace esperando pagamento por pessoa (lib/empresaPendente.ts) */
    const { pendente, error: pendErr } = await workspaceEsperandoPagamento(req.user.id);
    if (pendErr) return sendDbError(req, reply, pendErr);
    if (pendente) return reply.status(409).send(fail(msgWorkspacePendente(pendente.name)));

    const { cpf: cpfRawInput, ...workspaceFields } = parsed.data;

    /* CPF obrigatório e validado antes de criar qualquer coisa: com CPF inválido o workspace
       ficava criado sem assinatura, e sem assinatura não havia bloqueio nenhum */
    const cpf = sanitizeCpf(cpfRawInput ?? "");
    if (!cpf) {
      return reply.status(400).send(fail("CPF inválido. Informe um CPF válido para continuar."));
    }

    /* CPF já cadastrado por outra conta: cria o workspace, mas sem trial */
    const { data: cpfOwner } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("cpf", cpf)
      .neq("id", req.user.id)
      .maybeSingle();

    const { data: ws, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .insert({ ...workspaceFields, created_by: req.user.id })
      .select()
      .single();

    if (wsErr) return sendDbError(req, reply, wsErr);

    /* Teste reaproveitado ao recomeçar: no rollback ele volta a apontar para o workspace antigo, em vez de ser apagado */
    let reusado: { id: string; antigo: string | null } | null = null;

    /* Desfaz o que já foi criado se um passo seguinte falhar (cascade apaga membros e assinatura) */
    const rollback = async (err: { message: string }) => {
      req.log.error({ err, workspace_id: ws.id }, "falha ao criar workspace; desfazendo");
      if (reusado) await supabaseAdmin.from("trial_grants").update({ workspace_id: reusado.antigo }).eq("id", reusado.id);
      else await supabaseAdmin.from("trial_grants").delete().eq("workspace_id", ws.id);
      await supabaseAdmin.from("workspaces").delete().eq("id", ws.id);
      return sendDbError(req, reply, err);
    };

    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({ workspace_id: ws.id, user_id: req.user.id, role: "owner", status: "ativo" });

    if (memberErr) return rollback(memberErr);

    /* Salva CPF no perfil (só na primeira vez — não sobrescreve) */
    if (!cpfOwner) {
      await supabaseAdmin
        .from("profiles")
        .update({ cpf })
        .eq("id", req.user.id)
        .is("cpf", null);
    }

    /* Todos os planos têm teste grátis (`fimDoTeste` em lib/trial.ts: lançamento grátis até 05/01/2027,
       depois 14 dias). 1 trial por conta, por CPF e por e-mail normalizado: os índices únicos de trial_grants
       tornam a concessão atômica (antes a checagem usava um embed inexistente e todo workspace novo ganhava trial). */
    const plan = parsed.data.plan ?? "basic";
    let fimTeste: Date | null = null;

    if (!cpfOwner) {
      const { error: grantErr } = await supabaseAdmin.from("trial_grants").insert({
        user_id:      req.user.id,
        cpf_hash:     createHash("sha256").update(cpf).digest("hex"),
        email_hash:   req.user.email ? hashEmailDoTeste(req.user.email) : null,
        workspace_id: ws.id,
      });
      if (!grantErr) fimTeste = fimDoTeste();
      else if (grantErr.code !== "23505") req.log.error({ err: grantErr }, "falha ao registrar trial");
      else {
        /* Já usou: se excluiu o workspace do teste e o prazo não acabou, este usa o mesmo teste (lib/empresaPendente.ts).
           A troca só vale se o registro ainda aponta para o workspace antigo: dois pedidos juntos não levam dois testes */
        const { grant, recomecarAte, error: recErr } = await testeDaConta(req.user.id);
        if (recErr) req.log.error({ err: recErr }, "falha ao conferir o teste da conta");
        else if (grant && recomecarAte) {
          const antigo = (grant.workspace_id as string | null) ?? null;
          const troca  = supabaseAdmin.from("trial_grants").update({ workspace_id: ws.id }).eq("id", grant.id);
          const { data: assumiu } = await (antigo ? troca.eq("workspace_id", antigo) : troca.is("workspace_id", null)).select("id");
          if (Array.isArray(assumiu) && assumiu.length) {
            reusado  = { id: grant.id as string, antigo };
            fimTeste = recomecarAte;
          }
        }
      }
    }

    const hasTrial    = fimTeste !== null;
    const trialEndsAt = fimTeste?.toISOString() ?? null;

    const { error: subErr } = await supabaseAdmin.from("subscriptions").insert({
      workspace_id:  ws.id,
      plan,
      status:        hasTrial ? "trialing" : "trial_expired",
      trial_ends_at: trialEndsAt,
    });

    if (subErr) return rollback(subErr);

    /* trial: false = já usou o teste (ou o CPF é de outra conta): o front abre o pagamento */
    return reply.status(201).send(ok({ ...ws, trial: hasTrial }));
  });

  /*
   * POST /workspaces/:id/desistir — fechou o pagamento logo depois de criar (2026-10-28, pedido do João: quem
   * desiste não deixa workspace para trás). Só o dono, e só um workspace esperando pagamento (nasceu sem teste,
   * bloqueado, sem assinatura). Antes de apagar, o Stripe: checkout já pago → 409 (o webhook vai ativar);
   * checkout aberto → expira, para ninguém pagar um workspace apagado.
   */
  fastify.post("/workspaces/:id/desistir", authStrict, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!await requireMember(id, req.user.id, reply, ["owner"])) return;

    const { data: sub, error } = await supabaseAdmin
      .from("subscriptions")
      .select("status, trial_ends_at, stripe_subscription_id, stripe_customer_id")
      .eq("workspace_id", id)
      .maybeSingle();
    if (error) return sendDbError(req, reply, error);
    if (!sub || sub.status !== "trial_expired" || sub.trial_ends_at || sub.stripe_subscription_id) {
      return reply.status(409).send(fail("Este workspace não está esperando o primeiro pagamento."));
    }

    if (sub.stripe_customer_id) {
      try {
        const sessoes = await stripe.checkout.sessions.list({ customer: sub.stripe_customer_id, limit: 20 });
        if (sessoes.data.some((s) => s.status === "complete")) {
          return reply.status(409).send(fail("O pagamento já foi feito. Aguarde alguns segundos: o plano está sendo ativado."));
        }
        for (const s of sessoes.data.filter((s) => s.status === "open")) {
          await stripe.checkout.sessions.expire(s.id);
        }
      } catch (err) {
        /* Sem conferir o Stripe, não apaga: o workspace fica esperando pagamento (o limite de 1 continua valendo) */
        req.log.error({ err, workspace_id: id }, "desistir: falha ao conferir o checkout no Stripe");
        return reply.status(502).send(fail("Não foi possível cancelar agora. O workspace ficou esperando pagamento."));
      }
    }

    const { error: delErr } = await supabaseAdmin.from("workspaces").delete().eq("id", id);
    if (delErr) return sendDbError(req, reply, delErr);

    if (sub.stripe_customer_id) {
      await stripe.customers.del(sub.stripe_customer_id).catch((err) =>
        req.log.warn({ err, workspace_id: id }, "desistir: cliente do Stripe não apagado"));
    }
    return reply.send(ok({ apagado: true }));
  });

  /* PATCH /workspaces/:id */
  fastify.patch("/workspaces/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    if (!await assertActiveSubscription(id, reply)) return;

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { data, error } = await db
      .from("workspaces")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /**
   * DELETE /workspaces/:id — Excluir workspace (cancela na hora a assinatura do Stripe, se houver).
   * Cancelar só a assinatura, mantendo os dados, é pelo portal: POST /billing/portal { flow: "cancel" }.
   *
   * Regras:
   *  - Apenas o owner pode excluir.
   *  - Usa service role para contornar RLS e garantir deleção em cascata
   *    (members → products → movements → workspace).
   *  - O frontend deve limpar o localStorage e redirecionar para /login.
   */
  fastify.delete("/workspaces/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };

    /* 1. Verifica que o usuário autenticado é owner do workspace */
    const { data: membership, error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", id)
      .eq("user_id", req.user.id)
      .eq("status", "ativo")
      .single();

    if (memberErr || !membership) {
      return reply.status(403).send(fail("Workspace não encontrado."));
    }

    if (membership.role !== "owner") {
      return reply.status(403).send(fail("Apenas o owner pode excluir o workspace."));
    }

    /* 2. Cancela assinatura no Stripe se houver */
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("workspace_id", id)
      .maybeSingle();

    if (sub?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      } catch (err) {
        fastify.log.warn(err, "Falha ao cancelar assinatura no Stripe (prosseguindo com deleção)");
      }
    }

    /* 3. Deleta em cascata via service role
          A FK ON DELETE CASCADE cuida de:
            workspace_members → deletados pelo cascade do workspace
            products          → deletados pelo cascade do workspace
            movements         → deletados pelo cascade do produto
    */
    const { error: deleteErr } = await supabaseAdmin
      .from("workspaces")
      .delete()
      .eq("id", id);

    if (deleteErr) return sendDbError(req, reply, deleteErr);

    /* 4. Fotos dos produtos (Storage, fora do cascade). Se falhar, o job diário apaga as órfãs */
    await apagarFotosDoWorkspace(id).catch((err) => req.log.error({ err, workspace_id: id }, "workspace excluído, mas as fotos ficaram"));

    return reply.send(ok({ deleted: true }));
  });
};

export default workspacesRoutes;
