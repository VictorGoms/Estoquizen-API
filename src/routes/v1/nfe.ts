import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok, fail } from "../../lib/response.js";
import { consultarNfce } from "../../lib/nfce.js";

const ConsultarSchema = z.object({
  tipo:  z.enum(["nfce"]),
  chave: z.string()
    .transform((v) => v.replace(/\s/g, ""))
    .pipe(z.string().length(44, "Chave deve ter 44 dígitos").regex(/^\d+$/, "Chave deve conter apenas números")),
});

const nfeRoutes: FastifyPluginAsync = async (fastify) => {
  const auth      = { preHandler: [fastify.authenticate] };
  const authWrite = {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  };

  /* POST /nfe/consultar */
  fastify.post("/nfe/consultar", authWrite, async (req, reply) => {
    const parsed = ConsultarSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const { tipo, chave } = parsed.data;

    try {
      if (tipo === "nfce") {
        const itens = await consultarNfce(chave);
        if (itens.length === 0) {
          return reply.status(404).send(fail("Nenhum item encontrado. Verifique a chave e tente novamente."));
        }
        return reply.send(ok({ chave, total_itens: itens.length, itens }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao consultar nota fiscal.";
      return reply.status(502).send(fail(msg));
    }
  });
};

export default nfeRoutes;
