import type { FastifyPluginAsync } from "fastify";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema } from "../../schemas/workspace.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError } from "../../lib/response.js";
import { assertActiveSubscription } from "../../lib/checkSubscription.js";
import { sanitizeCpf } from "../../lib/sanitize.js";

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
      .select("role, status, workspaces(id, name, description, plan, created_at)")
      .eq("user_id", req.user.id)
      .eq("status", "ativo");

    if (error) return reply.status(500).send(fail(dbError(error)));
    return reply.send(ok(data));
  });

  /* GET /workspaces/:id/stats — contadores para o dashboard */
  fastify.get("/workspaces/:id/stats", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const token  = req.headers.authorization!.slice(7);
    const db     = supabaseForUser(token);

    const [{ count: produtos }, { count: alertas }, { count: movimentacoes }] = await Promise.all([
      db.from("products").select("id", { count: "exact", head: true }).eq("workspace_id", id),
      db.from("products").select("id", { count: "exact", head: true }).eq("workspace_id", id).lt("qty", 10),
      db.from("movements").select("id, products!inner(workspace_id)", { count: "exact", head: true })
        .eq("products.workspace_id", id),
    ]);

    return reply.send(ok({ produtos: produtos ?? 0, alertas: alertas ?? 0, movimentacoes: movimentacoes ?? 0 }));
  });

  /* POST /workspaces — cria workspace, owner e subscription de trial */
  fastify.post("/workspaces", authStrict, async (req, reply) => {
    const parsed = CreateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const { data: ws, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .insert({ ...parsed.data, created_by: req.user.id })
      .select()
      .single();

    if (wsErr) return reply.status(500).send(fail(dbError(wsErr)));

    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({ workspace_id: ws.id, user_id: req.user.id, role: "owner", status: "ativo" });

    if (memberErr) return reply.status(500).send(fail(dbError(memberErr)));

    /* Valida e salva CPF — obrigatório para todos os planos */
    const cpfRaw = parsed.data.cpf ?? "";
    const cpf    = sanitizeCpf(cpfRaw);
    if (!cpf) {
      return reply.status(400).send(fail("CPF inválido. Informe um CPF válido para continuar."));
    }

    /* Salva CPF no perfil (só na primeira vez — não sobrescreve) */
    await supabaseAdmin
      .from("profiles")
      .update({ cpf })
      .eq("id", req.user.id)
      .is("cpf", null);

    /* Apenas o plano growth tem trial gratuito — basic e pro exigem pagamento imediato */
    const plan = parsed.data.plan ?? "basic";
    let hasTrial = plan === "growth";

    if (hasTrial) {
      /* Verifica se este CPF já usou um trial em qualquer workspace */
      const { data: existingCpf } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("cpf", cpf)
        .neq("id", req.user.id) // ignora o próprio usuário
        .maybeSingle();

      if (existingCpf) {
        hasTrial = false; // CPF já cadastrado por outro usuário → sem trial
      } else {
        /* Verifica se o próprio usuário já teve trial em outro workspace */
        const { data: previousSub } = await supabaseAdmin
          .from("workspace_members")
          .select("workspace_id, subscriptions!inner(status)")
          .eq("user_id", req.user.id)
          .eq("role", "owner")
          .maybeSingle();

        if (previousSub) hasTrial = false;
      }
    }

    const trialDays   = new Date(ws.created_at) < new Date("2026-06-30") ? 30 : 14;
    const trialEndsAt = hasTrial
      ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    await supabaseAdmin.from("subscriptions").insert({
      workspace_id:  ws.id,
      plan,
      status:        hasTrial ? "trialing" : "trial_expired",
      trial_ends_at: trialEndsAt,
    });

    return reply.status(201).send(ok(ws));
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

    if (error) return reply.status(500).send(fail(dbError(error)));
    return reply.send(ok(data));
  });

  /**
   * DELETE /workspaces/:id — Encerrar assinatura e excluir workspace.
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
      return reply.status(403).send(fail("Apenas o owner pode encerrar a assinatura."));
    }

    /* 2. Deleta em cascata via service role
          A FK ON DELETE CASCADE cuida de:
            workspace_members → deletados pelo cascade do workspace
            products          → deletados pelo cascade do workspace
            movements         → deletados pelo cascade do produto
    */
    const { error: deleteErr } = await supabaseAdmin
      .from("workspaces")
      .delete()
      .eq("id", id);

    if (deleteErr) return reply.status(500).send(fail(dbError(deleteErr)));

    return reply.send(ok({ deleted: true }));
  });
};

export default workspacesRoutes;
