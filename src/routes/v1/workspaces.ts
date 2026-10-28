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
import { workspaceEsperandoPagamento, msgWorkspacePendente } from "../../lib/empresaPendente.js";

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
    /* Pela conta ou pelo e-mail normalizado da própria conta (o "+algo" do mesmo Gmail não ganha outro teste) */
    const porEmail = req.user.email ? `,email_hash.eq.${hashEmailDoTeste(req.user.email)}` : "";
    const [{ data: grant, error }, { pendente, error: pendErr }] = await Promise.all([
      supabaseAdmin.from("trial_grants").select("user_id").or(`user_id.eq.${req.user.id}${porEmail}`).limit(1).maybeSingle(),
      workspaceEsperandoPagamento(req.user.id),
    ]);
    if (error || pendErr) return sendDbError(req, reply, (error ?? pendErr)!);
    return reply.send(ok({ disponivel: !grant, pendente }));
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

    /* Desfaz o que já foi criado se um passo seguinte falhar (cascade apaga membros e assinatura) */
    const rollback = async (err: { message: string }) => {
      req.log.error({ err, workspace_id: ws.id }, "falha ao criar workspace; desfazendo");
      await supabaseAdmin.from("trial_grants").delete().eq("workspace_id", ws.id);
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
    let hasTrial = false;

    if (!cpfOwner) {
      const { error: grantErr } = await supabaseAdmin.from("trial_grants").insert({
        user_id:      req.user.id,
        cpf_hash:     createHash("sha256").update(cpf).digest("hex"),
        email_hash:   req.user.email ? hashEmailDoTeste(req.user.email) : null,
        workspace_id: ws.id,
      });
      if (!grantErr) hasTrial = true;
      else if (grantErr.code !== "23505") req.log.error({ err: grantErr }, "falha ao registrar trial");
    }

    const trialEndsAt = hasTrial ? fimDoTeste().toISOString() : null;

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
