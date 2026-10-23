import type { FastifyPluginAsync } from "fastify";
import { runCleanup } from "../../lib/cleanup.js";
import { diagnosticoNfce } from "../../lib/nfceMonitor.js";

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

  /* POST /admin/nfce-diagnostico — força o diagnóstico da NFC-e agora (sem esperar os 7 dias).
     Mesmo header: Authorization: Bearer <CRON_SECRET>. Leva alguns minutos (um estado por vez) */
  fastify.post("/admin/nfce-diagnostico", async (req, reply) => {
    const secret = process.env.CRON_SECRET ?? "";
    const auth   = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (!secret || auth !== secret) return reply.status(401).send({ error: "Unauthorized" });
    return reply.send({ ok: true, ...(await diagnosticoNfce(fastify.log, true)) });
  });
};

export default cleanupRoutes;
