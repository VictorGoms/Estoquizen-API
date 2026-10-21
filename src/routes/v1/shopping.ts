import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok, fail, sendDbError } from "../../lib/response.js";
import { requireMember } from "../../lib/membership.js";
import { assertActiveSubscription } from "../../lib/checkSubscription.js";
import { ShoppingItemSchema } from "../../schemas/shopping.schema.js";

/*
 * Lista de compras: itens adicionados à mão (2026-10-21). A parte automática (no mínimo ou acabando
 * em 7 dias) é calculada no front. Qualquer membro do workspace adiciona e remove, como numa lista
 * de papel na parede. Usa supabaseAdmin, então toda rota chama requireMember antes.
 */
const shoppingRoutes: FastifyPluginAsync = async (fastify) => {
  const auth      = { preHandler: [fastify.authenticate] };
  const authWrite = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  /* GET /shopping-list?workspace_id= — itens à mão. Os que já tiveram entrada depois de serem
     adicionados (foram comprados) saem da lista aqui mesmo */
  fastify.get("/shopping-list", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));
    if (!await requireMember(workspace_id, req.user.id, reply)) return;

    const { data: itens, error } = await supabaseAdmin
      .from("shopping_list_items")
      .select("id, product_id, qty, added_by, created_at")
      .eq("workspace_id", workspace_id)
      .order("created_at");
    if (error) return sendDbError(req, reply, error);
    if (!itens?.length) return reply.send(ok([]));

    const t = (iso: string) => new Date(iso).getTime();
    const desde = new Date(Math.min(...itens.map((i) => t(i.created_at)))).toISOString();
    const { data: entradas, error: errMov } = await supabaseAdmin
      .from("movements")
      .select("product_id, created_at")
      .in("product_id", itens.map((i) => i.product_id))
      .gt("delta", 0)
      .gte("created_at", desde);
    if (errMov) return sendDbError(req, reply, errMov);

    const comprados = itens.filter((i) => (entradas ?? []).some((m) => m.product_id === i.product_id && t(m.created_at) > t(i.created_at)));
    if (comprados.length) {
      await supabaseAdmin.from("shopping_list_items").delete().in("id", comprados.map((i) => i.id));
    }
    const restantes = itens.filter((i) => !comprados.includes(i));
    return reply.send(ok(restantes.map((i) => ({ ...i, qty: Number(i.qty) }))));
  });

  /* POST /shopping-list { workspace_id, product_id, qty } — adiciona ou troca a quantidade */
  fastify.post("/shopping-list", authWrite, async (req, reply) => {
    const parsed = ShoppingItemSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));
    const { workspace_id, product_id, qty } = parsed.data;

    if (!await requireMember(workspace_id, req.user.id, reply)) return;
    if (!await assertActiveSubscription(workspace_id, reply)) return;

    const { data: produto } = await supabaseAdmin
      .from("products").select("id").eq("id", product_id).eq("workspace_id", workspace_id).maybeSingle();
    if (!produto) return reply.status(404).send(fail("Produto não encontrado neste workspace."));

    const { data, error } = await supabaseAdmin
      .from("shopping_list_items")
      .upsert({ workspace_id, product_id, qty, added_by: req.user.id }, { onConflict: "workspace_id,product_id" })
      .select("id, product_id, qty, added_by, created_at")
      .single();
    if (error) return sendDbError(req, reply, error);
    return reply.status(201).send(ok({ ...data, qty: Number(data.qty) }));
  });

  /* DELETE /shopping-list/:id?workspace_id= — tira da lista */
  fastify.delete("/shopping-list/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));
    if (!await requireMember(workspace_id, req.user.id, reply)) return;

    const { error } = await supabaseAdmin
      .from("shopping_list_items").delete().eq("id", id).eq("workspace_id", workspace_id);
    if (error) return sendDbError(req, reply, error);
    return reply.send(ok(null));
  });
};

export default shoppingRoutes;
