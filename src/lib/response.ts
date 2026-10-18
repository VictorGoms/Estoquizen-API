import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiResponse } from "../types/index.js";

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiResponse<T> {
  return { data, error: null, ...(meta ? { meta } : {}) };
}

export function fail(error: string): ApiResponse<null> {
  return { data: null, error };
}

/**
 * Sanitiza erros do banco antes de enviar ao cliente.
 * Impede vazamento de nomes de tabelas, constraints e estrutura interna.
 */
export function dbError(error: { message: string }, fallback = "Erro interno. Tente novamente."): string {
  const msg = error.message.toLowerCase();

  // Erros de negócio que podem ser exibidos diretamente
  if (msg.includes("não encontrado") || msg.includes("insuficiente") || msg.includes("acesso negado")) {
    return error.message;
  }

  // Violação de unicidade — mensagem amigável sem expor constraint name
  if (msg.includes("unique") || msg.includes("duplicate")) {
    return "Já existe um registro com esses dados.";
  }

  // Violação de NOT NULL
  if (msg.includes("null value") || msg.includes("not-null")) {
    return "Campo obrigatório não preenchido.";
  }

  // Violação de FK ou RLS
  if (msg.includes("foreign key") || msg.includes("violates row-level")) {
    return "Operação inválida: referência inexistente.";
  }

  // Violação genérica de constraint
  if (msg.includes("violates")) {
    return fallback;
  }

  // Qualquer outro erro do banco — não expõe detalhes
  return fallback;
}

/** Status HTTP de um erro do Postgres/PostgREST, pelo código (SQLSTATE). */
export function dbStatus(error: { code?: string }): number {
  switch (error.code) {
    case "23505":                         return 409; // registro duplicado
    case "23503": case "23502": case "23514":
    case "22P02": case "22003":           return 400; // FK, NOT NULL, CHECK, formato, faixa
    case "42501":                         return 403; // RLS ou trigger de permissão
    case "PGRST116":                      return 404; // .single() sem linha
    default:                              return 500;
  }
}

/**
 * Responde um erro do banco com o status certo e a mensagem saneada.
 * Nos 500 registra o erro original no log (antes os 500 não deixavam rastro).
 */
export function sendDbError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: { message: string; code?: string },
) {
  const status = dbStatus(error);
  if (status >= 500) req.log.error({ err: error, method: req.method, url: req.url }, "erro de banco");

  /* 42501 de trigger já vem com mensagem para o usuário; o de RLS, não */
  const message = status === 403
    ? (/row-level security/i.test(error.message) ? "Você não tem permissão para esta ação." : error.message)
    : dbError(error);

  return reply.status(status).send(fail(message));
}
