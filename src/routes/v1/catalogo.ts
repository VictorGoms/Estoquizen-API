import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../../lib/supabase.js";
import { ok } from "../../lib/response.js";
import { sanitizeCode } from "../../lib/sanitize.js";
import { gtinValido } from "../../lib/nfeChave.js";
import { nomeSugerido, type FonteNome } from "../../lib/catalogo.js";

/* Catálogo próprio de códigos de barras (EQZ-53): regra em src/lib/catalogo.ts */
const catalogoRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [fastify.authenticate] };

  /* GET /catalogo/:codigo — nome sugerido para um código de barras, ou null. Lê todos os workspaces
     (supabaseAdmin), mas só devolve o nome, e só quando ele passa na regra do catálogo */
  fastify.get("/catalogo/:codigo", auth, async (req, reply) => {
    const codigo = sanitizeCode((req.params as { codigo?: string }).codigo);
    if (!gtinValido(codigo)) return reply.send(ok(null));

    const [produtos, notas] = await Promise.all([
      supabaseAdmin.from("products").select("name, workspace_id").eq("code", codigo).limit(200),
      supabaseAdmin.from("nota_imports").select("itens, workspace_id").filter("itens", "cs", JSON.stringify([{ code: codigo }])).limit(50),
    ]);
    if (produtos.error || notas.error) {
      req.log.error({ err: produtos.error ?? notas.error, codigo }, "falha ao ler o catálogo");
      return reply.send(ok(null));
    }

    const wsIds = [...new Set([...produtos.data, ...notas.data].map((r) => r.workspace_id as string))];
    if (!wsIds.length) return reply.send(ok(null));
    const { data: workspaces } = await supabaseAdmin.from("workspaces").select("id, created_by").in("id", wsIds);
    const dono = new Map((workspaces ?? []).map((w) => [w.id as string, w.created_by as string]));
    const donoDe = (ws: string) => dono.get(ws) ?? ws;

    const fontes: FonteNome[] = [
      ...produtos.data.map((p) => ({ nome: p.name as string, dono: donoDe(p.workspace_id), daNota: false })),
      ...notas.data.flatMap((n) => (n.itens as { code?: string; name?: string }[])
        .filter((i) => i.code === codigo && i.name)
        .map((i) => ({ nome: i.name!, dono: donoDe(n.workspace_id), daNota: true }))),
    ];
    return reply.send(ok(nomeSugerido(fontes)));
  });
};

export default catalogoRoutes;
