import type { FastifyPluginAsync } from "fastify";
import { CreateProductSchema, UpdateProductSchema, AdjustQtySchema, CountSchema, ImportProductsSchema } from "../../schemas/product.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { getLimits } from "../../lib/plans.js";
import { requireMember, type Role } from "../../lib/membership.js";
import { assertActiveSubscription, getProductWorkspaceId } from "../../lib/checkSubscription.js";

/* Cadastrar, editar e excluir produto é de dono e admin (SCRUM-62). Entrada, saída e contagem
   ficam com qualquer membro: as RPCs só exigem ser do workspace */
const GESTORES: Role[] = ["owner", "admin"];
const SO_GESTORES = "Só donos e administradores podem cadastrar, editar ou excluir produtos.";

const productsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth      = { preHandler: [fastify.authenticate] };
  const authWrite = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  /* Importação de planilha grava até 2000 produtos por chamada (com textos longos passa de 1 MB, o padrão) */
  const authImport = {
    preHandler: [fastify.authenticate],
    bodyLimit:  3 * 1024 * 1024,
    config:     { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  /* GET /products?workspace_id=xxx */
  fastify.get("/products", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { data, error } = await db
      .from("products")
      .select("id, workspace_id, name, source_name, code, unit, price, qty, min_qty, max_qty, location, supplier, image_url, icon, nota_fiscal, created_at, updated_at")
      .eq("workspace_id", workspace_id)
      .order("name");

    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /* GET /products/:id */
  fastify.get("/products/:id", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const token  = req.headers.authorization!.slice(7);
    const db     = supabaseForUser(token);

    const { data, error } = await db
      .from("products")
      .select("id, workspace_id, name, source_name, code, unit, price, qty, min_qty, max_qty, location, supplier, image_url, icon, nota_fiscal, created_at, updated_at")
      .eq("id", id)
      .single();

    if (error) return reply.status(404).send(fail("Produto não encontrado"));
    return reply.send(ok(data));
  });

  /* POST /products */
  fastify.post("/products", authWrite, async (req, reply) => {
    const parsed = CreateProductSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    if (!await requireMember(parsed.data.workspace_id, req.user.id, reply, GESTORES, SO_GESTORES)) return;
    if (!await assertActiveSubscription(parsed.data.workspace_id, reply)) return;

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    /* ── Validação de limite do plano ── */
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("plan")
      .eq("id", parsed.data.workspace_id)
      .single();

    const limits = getLimits(ws?.plan ?? "basic");

    const { count } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", parsed.data.workspace_id);

    if ((count ?? 0) >= limits.products) {
      return reply.status(403).send(fail(
        `Limite do plano ${limits.label} atingido: máximo de ${limits.products} produtos. Faça upgrade para continuar.`
      ));
    }

    /* qty fica fora do insert: o estoque inicial entra pela RPC, que grava a movimentação
       (e o banco só deixa a RPC mexer em qty) */
    const { qty: initialQty = 0, ...fields } = parsed.data;

    /* code é optional no schema mas NOT NULL no banco — gera um código único quando não informado */
    const code = parsed.data.code ?? `AUTO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    const { data, error } = await db
      .from("products")
      .insert({ ...fields, code, source_name: fields.name, created_by: req.user.id })
      .select()
      .single();

    if (error) return sendDbError(req, reply, error);

    /* Se houver estoque inicial, registra como primeira movimentação */
    if (initialQty > 0) {
      const { data: adjusted, error: adjustError } = await db.rpc("adjust_product_qty", {
        p_product_id: data.id,
        p_delta:      initialQty,
        p_reason:     "Estoque inicial",
        p_user_id:    req.user.id,
      });

      if (adjustError) {
        /* Sem desfazer, o produto ficaria com estoque 0 sem o usuário saber.
           supabaseAdmin porque member não tem DELETE pela RLS; apaga só o produto recém-criado. */
        await supabaseAdmin.from("products").delete().eq("id", data.id);
        return sendDbError(req, reply, adjustError);
      }

      return reply.status(201).send(ok({ ...data, qty: (adjusted as { qty: number }).qty }));
    }

    return reply.status(201).send(ok(data));
  });

  /* POST /products/import — importa os produtos de uma planilha (EQZ-14) numa transação só
     (RPC import_products). Código que já existe no workspace é pulado e volta em "ignorados". */
  fastify.post("/products/import", authImport, async (req, reply) => {
    const parsed = ImportProductsSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.errors[0];
      const linha = issue.path[0] === "itens" && typeof issue.path[1] === "number" ? ` (linha ${issue.path[1] + 1} da importação)` : "";
      return reply.status(400).send(fail(issue.message + linha));
    }

    const { workspace_id, itens } = parsed.data;

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner", "admin"])) return;
    if (!await assertActiveSubscription(workspace_id, reply)) return;

    /* Mensagem clara antes de tentar; a trigger products_plan_limit garante no banco */
    const { data: ws } = await supabaseAdmin.from("workspaces").select("plan").eq("id", workspace_id).single();
    const limits = getLimits(ws?.plan ?? "basic");
    const { count } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace_id);

    if ((count ?? 0) + itens.length > limits.products) {
      const cabem = Math.max(limits.products - (count ?? 0), 0);
      return reply.status(403).send(fail(
        `Limite do plano ${limits.label}: cabem mais ${cabem} produtos (máximo de ${limits.products}) ` +
        `e a planilha tem ${itens.length}. Faça upgrade ou importe menos linhas.`
      ));
    }

    const token = req.headers.authorization!.slice(7);
    const { data, error } = await supabaseForUser(token).rpc("import_products", {
      p_workspace_id: workspace_id,
      p_itens:        itens,
    });

    if (error) {
      if (error.code === "22023") return reply.status(400).send(fail(error.message));
      return sendDbError(req, reply, error);
    }
    return reply.status(201).send(ok(data));
  });

  /* PATCH /products/:id */
  fastify.patch("/products/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateProductSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const wsId = await getProductWorkspaceId(id);
    if (!wsId) return reply.status(404).send(fail("Produto não encontrado."));
    if (!await requireMember(wsId, req.user.id, reply, GESTORES, SO_GESTORES)) return;
    if (!await assertActiveSubscription(wsId, reply)) return;

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { data, error } = await db
      .from("products")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /* POST /products/:id/adjust — entrada ou saída de estoque */
  fastify.post("/products/:id/adjust", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AdjustQtySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const wsId = await getProductWorkspaceId(id);
    if (wsId && !await assertActiveSubscription(wsId, reply)) return;

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    /* Ajuste atômico via RPC — sem race condition, sem divergência. A versão com p_motivo grava o
       motivo da saída (EQZ-23); na entrada o banco ignora o motivo */
    const { data, error } = await db.rpc("adjust_product_qty", {
      p_product_id: id,
      p_delta:      parsed.data.delta,
      p_motivo:     parsed.data.delta < 0 ? parsed.data.motivo ?? "venda" : null,
      p_reason:     parsed.data.reason ?? null,
      p_user_id:    req.user.id,
    });

    if (error) {
      const isNotFound = error.message.includes("não encontrado") || error.message.includes("insuficiente");
      const status = error.message.includes("Acesso negado") ? 403 : isNotFound ? 400 : 500;
      return reply.status(status).send(fail(dbError(error)));
    }
    return reply.send(ok(data));
  });

  /* POST /products/:id/count — contagem do dia (EQZ-17, Growth e Pro). A RPC register_stock_count
     registra a contagem e, se não bater, corrige o estoque com a movimentação "Ajuste de contagem". */
  fastify.post("/products/:id/count", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CountSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const wsId = await getProductWorkspaceId(id);
    if (!wsId) return reply.status(404).send(fail("Produto não encontrado."));
    if (!await assertActiveSubscription(wsId, reply)) return;

    const token = req.headers.authorization!.slice(7);
    const { data, error } = await supabaseForUser(token).rpc("register_stock_count", {
      p_product_id: id,
      p_counted:    parsed.data.counted,
    });

    /* 42501 (sem acesso, somente leitura, fora do plano) vira 403 com a mensagem da RPC */
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /* GET /products/:id/movements?since=<iso>&limit=<n> */
  fastify.get("/products/:id/movements", auth, async (req, reply) => {
    const { id }            = req.params as { id: string };
    const { since, limit }  = req.query  as { since?: string; limit?: string };

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    /* 1000 é o máximo do PostgREST; as métricas de 3 e 12 meses pedem tudo */
    const cap = Math.min(parseInt(limit ?? "200", 10) || 200, 1000);

    let query = db
      .from("movements")
      .select("id, delta, reason, created_at")
      .eq("product_id", id)
      .order("created_at", { ascending: false })
      .limit(cap);

    if (since) query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(data));
  });

  /* DELETE /products/:id */
  fastify.delete("/products/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };

    const wsId = await getProductWorkspaceId(id);
    if (!wsId) return reply.status(404).send(fail("Produto não encontrado."));
    if (!await requireMember(wsId, req.user.id, reply, GESTORES, SO_GESTORES)) return;
    if (!await assertActiveSubscription(wsId, reply)) return;

    const token  = req.headers.authorization!.slice(7);
    const db     = supabaseForUser(token);

    const { error } = await db.from("products").delete().eq("id", id);
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(null));
  });
};

export default productsRoutes;
