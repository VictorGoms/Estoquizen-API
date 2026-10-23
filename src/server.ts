import "dotenv/config";
import "./lib/zodPt.js";
import Fastify, { type FastifyError } from "fastify";
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
import { diagnosticoNfce } from "./lib/nfceMonitor.js";
import { rateLimitKey } from "./lib/rateLimitKey.js";

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
fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, function (req, body, done) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).rawBody = body;
  try {
    done(null, JSON.parse((body as Buffer).toString("utf8")));
  } catch {
    /* Sem statusCode o erro virava 500; JSON malformado é erro de quem chamou */
    done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
  }
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
  /* Por usuário quando o token tem assinatura válida (não bloqueia quem divide o mesmo IP,
     como o Wi-Fi de uma loja); senão pelo IP. Token forjado não ganha balde próprio (EQZ-44). */
  keyGenerator: rateLimitKey,
  /* O plugin lança este objeto: sem statusCode, o erro saía como 500 em vez de 429 */
  errorResponseBuilder: () => ({
    statusCode: 429,
    data:       null,
    error:      "Muitas requisições. Aguarde um momento e tente novamente.",
  }),
});

/* ── Erros: sempre { data, error } em português; 5xx vão para o log ── */
fastify.setNotFoundHandler((_req, reply) => {
  reply.status(404).send({ data: null, error: "Rota não encontrada." });
});

fastify.setErrorHandler<FastifyError>((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err, method: req.method, url: req.url }, "erro não tratado");

  const message =
    status === 429                      ? "Muitas requisições. Aguarde um momento e tente novamente." :
    status === 413                      ? "Os dados enviados são grandes demais." :
    err.message === "Invalid JSON"      ? "O corpo da requisição não é um JSON válido." :
    err.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ? "O corpo da requisição está vazio." :
    status >= 500                       ? "Erro interno. Tente novamente." :
    err.message;

  reply.status(status).send({ data: null, error: message });
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
/* O Railway põe a API para dormir (sleepApplication), e aí o cron das 4h UTC não roda.
   Por isso o job também roda quando o servidor sobe em produção: cada vez que a API acorda,
   recupera o que ficou para trás. É idempotente (aviso só uma vez por expiração, via warned_at). */
let cleanupRunning = false;
function runCleanupJob(origem: string) {
  if (cleanupRunning) return;
  cleanupRunning = true;
  runCleanup()
    .then((result) => {
      if (result.deleteErrors.length || result.emailErrors.length) {
        fastify.log.error({ ...result, origem }, "cleanup job concluído com falhas");
      } else {
        fastify.log.info({ ...result, origem }, "cleanup job concluído");
      }
    })
    .catch((err) => fastify.log.error({ err, origem }, "Erro no cleanup job"))
    .finally(() => { cleanupRunning = false; });
}

cron.schedule("0 4 * * *", () => runCleanupJob("cron"));

/* ── Diagnóstico da NFC-e (lib/nfceMonitor.ts): testa o portal de cada UF a partir do servidor.
   Roda de verdade no máximo 1 vez a cada 7 dias (a função confere), na subida e no cron das 4h ── */
let diagnosticoRodando = false;
function runDiagnosticoNfce() {
  if (diagnosticoRodando) return;
  diagnosticoRodando = true;
  diagnosticoNfce(fastify.log)
    .catch((err) => fastify.log.error({ err }, "Erro no diagnóstico da NFC-e"))
    .finally(() => { diagnosticoRodando = false; });
}
cron.schedule("15 4 * * *", () => runDiagnosticoNfce());

/* ── Start ── */
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  /* Só em produção: o .env local aponta para o mesmo banco */
  if (process.env.NODE_ENV === "production") { runCleanupJob("inicio"); runDiagnosticoNfce(); }
  console.log(`\n🚀 Estoquizen API rodando em http://localhost:${PORT}`);
  console.log(`📄 Documentação:          http://localhost:${PORT}/docs\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
