/**
 * Sanitização de inputs no backend.
 * Segunda camada de defesa — não depende do frontend.
 */

/** Remove null bytes, tags HTML e espaços extras. Trunca no limite. */
export function sanitizeText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\0/g, "")               // null bytes
    .replace(/<[^>]*>/g, "")          // tags HTML
    .replace(/[^\S\r\n]+/g, " ")      // espaços múltiplos
    .trim()
    .slice(0, maxLength);
}

/** Apenas dígitos, letras maiúsculas, hífen e ponto — para códigos de barras/SKU */
export function sanitizeCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\0/g, "")
    .replace(/[^a-zA-Z0-9\-_.]/g, "")
    .trim()
    .toUpperCase()
    .slice(0, 100);
}

/** Apenas dígitos e separadores decimais — para números */
export function sanitizeNumber(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[^0-9.,]/g, "").slice(0, 20);
}

/** Email: lowercase + trim + sem HTML */
export function sanitizeEmail(value: unknown): string {
  return sanitizeText(value, 254).toLowerCase();
}

/**
 * Lista grande demais para mandar ao schema (EQZ-59). O zod 3 valida item por item mesmo depois de
 * passar do `.max()`: 1 milhão de itens vazios num corpo de 3 MB viravam 1 milhão de erros, +600 MB de
 * memória e 3 s de CPU (medido em 2026-10-23), o bastante para derrubar a API. Confere antes do schema.
 */
export function listaGrandeDemais(corpo: unknown, campo: string, max: number): boolean {
  const lista = corpo && typeof corpo === "object" ? (corpo as Record<string, unknown>)[campo] : undefined;
  return Array.isArray(lista) && lista.length > max;
}

/** Remove formatação do CPF e valida dígitos verificadores. Retorna apenas dígitos ou null se inválido. */
export function sanitizeCpf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) return null;
  if (/^(\d)\1{10}$/.test(digits)) return null; // sequências repetidas (111.111.111-11 etc.)

  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 || rem === 11 ? 0 : rem;
  };
  if (calc(9) !== Number(digits[9])) return null;
  if (calc(10) !== Number(digits[10])) return null;
  return digits;
}
