import "dotenv/config";
import Fastify from "fastify";
import { Readable } from "node:stream";
import cors       from "@fastify/cors";
import helmet     from "@fastify/helmet";
import sensible   from "@fastify/sensible";
import rateLimit  from "@fastify/rate-limit";
import swagger    from "@fastify/swagger";
import swaggerUi  from "@fastify/swagger-ui";

import cron          from "node-cron";
import authPlugin    from "./plugins/auth.js";
import v1Routes      from "./routes/v1/index.js";
import webhookRoutes from "./routes/webhooks.js";
import cleanupRoutes from "./routes/admin/cleanup.js";
import { runCleanup } from "./lib/cleanup.js";

const PORT   = Number(process.env.PORT ?? 3001);
const IS_DEV = process.env.NODE_ENV !== "production";

const fastify = Fastify({
  logger: {
    level: IS_DEV ? "info" : "warn",
    transport: IS_DEV
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  },
});

/* ── Raw body — necessário para validar assinatura do webhook Stripe ── */
fastify.addHook("preParsing", async function (request, _reply, payload) {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const raw = Buffer.concat(chunks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (request as any).rawBody = raw;
  return Readable.from(raw); // devolve stream novo para o body parser do Fastify
});

/* ── Plugins de segurança ── */
await fastify.register(helmet, { contentSecurityPolicy: false });

await fastify.register(cors, {
  origin: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim()),
  methods:     ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
});

await fastify.register(sensible);

/* ── Rate limiting ──────────────────────────────────────────────
   Limites por IP para proteger contra bots e abuso de endpoints.

   Global (todas as rotas):  200 req / minuto por IP
   Auth (login/register):     10 req / minuto por IP — evita brute force
   Mutações (POST/PATCH):     60 req / minuto por IP
─────────────────────────────────────────────────────────────── */
await fastify.register(rateLimit, {
  global:    true,
  max:       200,
  timeWindow: "1 minute",
  /* Usa userId quando autenticado, fallback para IP — evita bloquear
     usuários legítimos atrás do mesmo IP (empresa, Wi-Fi corporativo). */
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      /* Extrai o `sub` do payload sem verificar assinatura (já verificado
         pelo plugin de auth). Só queremos o identificador do usuário. */
      try {
        const payload = JSON.parse(
          Buffer.from(auth.slice(7).split(".")[1], "base64url").toString("utf8")
        );
        if (payload?.sub) return `user:${payload.sub}`;
      } catch {
        /* token malformado — cai no IP */
      }
    }
    return req.ip;
  },
  errorResponseBuilder: () => ({
    data:  null,
    error: "Muitas requisições. Aguarde um momento e tente novamente.",
  }),
});

/* ── Documentação automática (disponível em /docs) ── */
await fastify.register(swagger, {
  openapi: {
    info:       { title: "Estoquizen API", version: "1.0.0", description: "API do sistema de gestão de estoque" },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    security:   [{ bearerAuth: [] }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig:    { docExpansion: "list", deepLinking: true },
});

/* ── Auth plugin ── */
await fastify.register(authPlugin);

/* ── Rotas ── */
await fastify.register(v1Routes,      { prefix: "/api/v1" });
await fastify.register(webhookRoutes);
await fastify.register(cleanupRoutes);

/* ── Cron: limpeza de workspaces expirados (todo dia às 4h UTC) ── */
cron.schedule("0 4 * * *", () => {
  runCleanup().catch((err) => fastify.log.error(err, "Erro no cleanup job"));
});

/* ── Start ── */
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`\n🚀 Estoquizen API rodando em http://localhost:${PORT}`);
  console.log(`📄 Documentação:          http://localhost:${PORT}/docs\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
