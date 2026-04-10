import type { FastifyPluginAsync } from "fastify";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema } from "../../schemas/workspace.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError } from "../../lib/response.js";

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

  /* POST /workspaces — cria workspace e define o criador como owner */
  fastify.post("/workspaces", authStrict, async (req, reply) => {
    const parsed = CreateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    /* Usa service role para criar workspace (operação privilegiada) */
    const { data: ws, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .insert({ ...parsed.data, created_by: req.user.id })
      .select()
      .single();

    if (wsErr) return reply.status(500).send(fail(dbError(wsErr)));

    /* Adiciona criador como owner */
    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({ workspace_id: ws.id, user_id: req.user.id, role: "owner", status: "ativo" });

    if (memberErr) return reply.status(500).send(fail(dbError(memberErr)));

    return reply.status(201).send(ok(ws));
  });

  /* PATCH /workspaces/:id */
  fastify.patch("/workspaces/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

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
