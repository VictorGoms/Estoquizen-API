import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { runCleanup } from "../../lib/cleanup.js";
import { diagnosticoNfce } from "../../lib/nfceMonitor.js";

/* Authorization: Bearer <CRON_SECRET>, comparado em tempo constante (EQZ-59). Sem a variável,
   ninguém entra */
export function cronAutorizado(header: string | undefined): boolean {
  const secret  = process.env.CRON_SECRET ?? "";
  const enviado = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secret || !enviado) return false;
  const a = Buffer.from(enviado);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const cleanupRoutes: FastifyPluginAsync = async (fastify) => {
  /* Quem acerta o segredo não precisa de mais que isto; quem tenta adivinhar fica bem mais lento */
  const admin = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

  /* POST /admin/cleanup — pode ser chamado manualmente para forçar a limpeza
     Header obrigatório: Authorization: Bearer <CRON_SECRET>
  */
  fastify.post("/admin/cleanup", admin, async (req, reply) => {
    if (!cronAutorizado(req.headers.authorization)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const result = await runCleanup();
    fastify.log.info(result, "cleanup manual concluído");
    return reply.send({ ok: true, ...result });
  });

  /* POST /admin/nfce-diagnostico — força o diagnóstico da NFC-e agora (sem esperar os 7 dias).
     Mesmo header: Authorization: Bearer <CRON_SECRET>. Leva alguns minutos (um estado por vez) */
  fastify.post("/admin/nfce-diagnostico", admin, async (req, reply) => {
    if (!cronAutorizado(req.headers.authorization)) return reply.status(401).send({ error: "Unauthorized" });
    return reply.send({ ok: true, ...(await diagnosticoNfce(fastify.log, true)) });
  });
};

export default cleanupRoutes;
