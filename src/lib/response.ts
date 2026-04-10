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
