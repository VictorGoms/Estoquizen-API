import type { User } from "@supabase/supabase-js";

/* ── Augmenta o FastifyRequest para carregar o usuário autenticado ── */
declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

/* ── Resposta padrão da API ── */
export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
  meta?: Record<string, unknown>;
}
