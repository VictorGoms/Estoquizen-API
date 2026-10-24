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

    /* Fonte "nota" = só o que a API leu da SEFAZ (catalogo_sefaz, EQZ-60). Antes procurava em
       nota_imports.itens, que é a quantidade de itens (integer): a consulta dava erro e o catálogo
       nunca respondeu. E os itens de /nfe/importar vêm do navegador: não servem como descrição */
    const [produtos, sefaz] = await Promise.all([
      supabaseAdmin.from("products").select("name, workspace_id").eq("code", codigo).limit(200),
      supabaseAdmin.from("catalogo_sefaz").select("nome").eq("codigo", codigo).limit(20),
    ]);
    if (produtos.error || sefaz.error) {
      req.log.error({ err: produtos.error ?? sefaz.error, codigo }, "falha ao ler o catálogo");
      return reply.send(ok(null));
    }

    const wsIds = [...new Set(produtos.data.map((r) => r.workspace_id as string))];
    const { data: workspaces } = wsIds.length
      ? await supabaseAdmin.from("workspaces").select("id, created_by").in("id", wsIds)
      : { data: [] };
    const dono = new Map((workspaces ?? []).map((w) => [w.id as string, w.created_by as string]));
    const donoDe = (ws: string) => dono.get(ws) ?? ws;

    const fontes: FonteNome[] = [
      ...produtos.data.map((p) => ({ nome: p.name as string, dono: donoDe(p.workspace_id), daNota: false })),
      ...sefaz.data.map((s) => ({ nome: s.nome as string, dono: "sefaz", daNota: true })),
    ];
    return reply.send(ok(nomeSugerido(fontes)));
  });
};

export default catalogoRoutes;
