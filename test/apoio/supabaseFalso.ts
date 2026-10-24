/*
 * Supabase falso para testar as rotas sem banco (auditoria de segurança de 2026-10-23).
 * Cada `from(tabela)` vira uma consulta registrada em `falso.chamadas`; a resposta vem de
 * `falso.responder`, que cada teste define. As funções do Auth são vi.fn para conferir o que a rota
 * chamou. Nada sai da máquina.
 *
 * Uso no arquivo de teste (o vi.mock é içado para o topo pelo Vitest):
 *   vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());
 */
import { vi } from "vitest";
import Fastify, { type FastifyPluginAsync } from "fastify";

export type Operacao = "select" | "insert" | "update" | "upsert" | "delete";

export interface Consulta {
  tabela:  string;
  op:      Operacao;
  /** "coluna" para eq; "coluna:in", "coluna:neq", "coluna:is"... para os outros filtros */
  filtros: Record<string, unknown>;
  dados?:  unknown;
}

export interface Resposta {
  data?:  unknown;
  error?: { message: string; code?: string } | null;
  count?: number;
}

class ConsultaFalsa implements PromiseLike<{ data: unknown; error: unknown; count: number | null }> {
  private c: Consulta;

  constructor(tabela: string) {
    this.c = { tabela, op: "select", filtros: {} };
  }

  select()           { return this; }
  insert(d: unknown) { this.c.op = "insert"; this.c.dados = d; return this; }
  update(d: unknown) { this.c.op = "update"; this.c.dados = d; return this; }
  upsert(d: unknown) { this.c.op = "upsert"; this.c.dados = d; return this; }
  delete()           { this.c.op = "delete"; return this; }

  eq(col: string, v: unknown)     { this.c.filtros[col] = v; return this; }
  neq(col: string, v: unknown)    { this.c.filtros[`${col}:neq`] = v; return this; }
  in(col: string, v: unknown)     { this.c.filtros[`${col}:in`] = v; return this; }
  is(col: string, v: unknown)     { this.c.filtros[`${col}:is`] = v; return this; }
  gte(col: string, v: unknown)    { this.c.filtros[`${col}:gte`] = v; return this; }
  gt(col: string, v: unknown)     { this.c.filtros[`${col}:gt`] = v; return this; }
  lt(col: string, v: unknown)     { this.c.filtros[`${col}:lt`] = v; return this; }
  ilike(col: string, v: unknown)  { this.c.filtros[`${col}:ilike`] = v; return this; }
  or(expr: string)                { this.c.filtros[":or"] = expr; return this; }
  filter(col: string, op: string, v: unknown) { this.c.filtros[`${col}:${op}`] = v; return this; }
  order()       { return this; }
  limit()       { return this; }
  single()      { return this; }
  maybeSingle() { return this; }

  then<A = { data: unknown; error: unknown; count: number | null }, B = never>(
    ok?: ((v: { data: unknown; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
    erro?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    falso.chamadas.push(this.c);
    const r = falso.responder(this.c) ?? {};
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }).then(ok, erro);
  }
}

const ok = (data: unknown = null) => ({ data, error: null });

export const falso = {
  responder: (_c: Consulta): Resposta | undefined => undefined,
  chamadas:  [] as Consulta[],
  cliente: {
    from: (tabela: string) => new ConsultaFalsa(tabela),
    rpc:  vi.fn(async (_nome: string, _args?: unknown) => ok()),
    auth: {
      /* "token-<id>" é um token válido do usuário <id> */
      getUser: vi.fn(async (token: string) =>
        token.startsWith("token-")
          ? { data: { user: { id: token.slice(6), email: `${token.slice(6)}@teste` } }, error: null }
          : { data: { user: null }, error: { message: "invalid JWT" } }),
      signInWithOtp: vi.fn(async (_opts: unknown) => ok()),
      admin: {
        getUserById:       vi.fn(async (_id: string) => ok({ user: null })),
        deleteUser:        vi.fn(async (_id: string) => ok()),
        inviteUserByEmail: vi.fn(async (_email: string, _opts?: unknown) => ok({ user: { id: "novo" } })),
        updateUserById:    vi.fn(async (_id: string, _attrs?: unknown) => ok()),
      },
    },
  },
  /** Volta ao estado inicial entre os testes */
  limpar() {
    falso.responder = () => undefined;
    falso.chamadas.length = 0;
    vi.clearAllMocks();
  },
  /** Consultas feitas a uma tabela, para conferir o que a rota gravou */
  em(tabela: string, op?: Operacao) {
    return falso.chamadas.filter((c) => c.tabela === tabela && (!op || c.op === op));
  },
};

/** O que o vi.mock de "../src/lib/supabase.js" devolve */
export function moduloSupabase() {
  return { supabaseAdmin: falso.cliente, supabaseForUser: (_token: string) => falso.cliente };
}

/** Fastify com o mesmo leitor de JSON (rawBody) e o mesmo auth do server.ts, e as rotas pedidas */
export async function montarApp(rotas: FastifyPluginAsync, prefix = "/api/v1") {
  const { default: authPlugin } = await import("../../src/plugins/auth.js");
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString("utf8"))); } catch (err) { done(err as Error); }
  });
  await app.register(authPlugin);
  await app.register(rotas, { prefix });
  return app;
}

/** Header de quem está logado como <userId> */
export const comoUsuario = (userId: string) => ({ authorization: `Bearer token-${userId}` });
