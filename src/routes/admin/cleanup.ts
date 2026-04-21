import type { FastifyPluginAsync } from "fastify";
import { runCleanup } from "../../lib/cleanup.js";

const cleanupRoutes: FastifyPluginAsync = async (fastify) => {
  /* POST /admin/cleanup — pode ser chamado manualmente para forçar a limpeza
     Header obrigatório: Authorization: Bearer <CRON_SECRET>
  */
  fastify.post("/admin/cleanup", async (req, reply) => {
    const secret = process.env.CRON_SECRET ?? "";
    const auth   = (req.headers.authorization ?? "").replace("Bearer ", "");

    if (!secret || auth !== secret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const result = await runCleanup();
    fastify.log.info(result, "cleanup manual concluído");
    return reply.send({ ok: true, ...result });
  });
};

export default cleanupRoutes;
