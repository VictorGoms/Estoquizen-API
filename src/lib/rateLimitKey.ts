import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Chave do rate limit (EQZ-44).
 *
 * Antes, o `sub` do JWT era lido sem conferir a assinatura: um token forjado com um `sub`
 * qualquer ganhava um balde novo a cada requisição, e o limite não valia para ninguém.
 * Agora o token só conta como `user:<sub>` se a assinatura ES256 bater com uma chave pública
 * do Supabase (JWKS) e ele não estiver vencido; senão, conta pelo IP.
 *
 * A verificação é local, sem chamar o Supabase a cada requisição. Quem autentica de verdade
 * continua sendo o `fastify.authenticate` (getUser), que também pega sessão revogada.
 */

const JWKS_TTL_MS   = 10 * 60 * 1000; // renova as chaves a cada 10 minutos
const JWKS_RETRY_MS = 60 * 1000;      // kid desconhecido ou falha: no máximo 1 busca por minuto

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function createTokenVerifier(supabaseUrl: string, fetchFn: Fetch = fetch) {
  const issuer  = `${supabaseUrl}/auth/v1`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;

  let keys = new Map<string, KeyObject>();
  let fetchedAt   = 0;
  let attemptedAt = 0;
  let loading: Promise<void> | null = null;

  async function loadKeys() {
    attemptedAt = Date.now();
    const res = await fetchFn(jwksUrl);
    if (!res.ok) return;
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; alg?: string })[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "EC" || jwk.crv !== "P-256" || (jwk.alg && jwk.alg !== "ES256")) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    /* Falha ou JWKS vazio mantém as chaves antigas */
    if (next.size) {
      keys = next;
      fetchedAt = Date.now();
    }
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = Date.now();
    const fresh = keys.has(kid) && now - fetchedAt < JWKS_TTL_MS;
    if (!fresh && !loading && now - attemptedAt >= JWKS_RETRY_MS) {
      loading = loadKeys().catch(() => {}).finally(() => { loading = null; });
    }
    /* Busca em andamento (ex.: logo depois de subir): espera por ela em vez de cair no IP */
    if (!fresh && loading) await loading;
    return keys.get(kid);
  }

  /** `sub` do token se a assinatura e as datas valem; senão null. Nunca lança exceção. */
  return async function verifiedSub(token: string): Promise<string | null> {
    try {
      const [rawHeader, rawPayload, rawSignature, extra] = token.split(".");
      if (!rawSignature || extra !== undefined) return null;

      const header  = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
      const payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8"));

      /* Só ES256 com kid: "none", HS256 e afins nem chegam a buscar chave */
      if (header?.alg !== "ES256" || typeof header.kid !== "string") return null;
      if (typeof payload?.sub !== "string" || !payload.sub) return null;
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
      if (payload.iss !== issuer) return null;

      const key = await keyFor(header.kid);
      if (!key) return null;

      const valid = verify(
        "sha256",
        Buffer.from(`${rawHeader}.${rawPayload}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(rawSignature, "base64url"),
      );
      return valid ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

const verifiedSub = createTokenVerifier(process.env.SUPABASE_URL ?? "");

/**
 * IP de quem conectou. No Railway o `req.ip` é o do proxy interno (igual para todos);
 * a borda grava o IP real em `X-Real-IP`. Pelo site, quem conecta é a Vercel (rewrite
 * `/api/v1`), então esse IP é o da Vercel: quem está logado conta pelo usuário, não por ele.
 */
export function clientIp(req: FastifyRequest): string {
  if (process.env.RAILWAY_ENVIRONMENT_NAME) {
    const realIp = req.headers["x-real-ip"];
    if (typeof realIp === "string" && realIp) return realIp;
  }
  return req.ip;
}

export async function rateLimitKey(req: FastifyRequest): Promise<string> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const sub = await verifiedSub(auth.slice(7));
    if (sub) return `user:${sub}`;
  }
  return `ip:${clientIp(req)}`;
}
