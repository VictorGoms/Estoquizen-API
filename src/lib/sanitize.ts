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
