/**
 * Regras da chave de acesso da NF-e/NFC-e e dos códigos dos itens (SCRUM-59).
 * Espelhadas no front em src/lib/nfe.ts.
 */

/** Dígito verificador dos 43 primeiros números: módulo 11 com pesos 2 a 9 da direita para a esquerda. */
export function digitoDaChave(inicio43: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = 42; i >= 0; i--) {
    soma += Number(inicio43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * Chave de 44 números que passa na validação mas não é de nota nenhuma: UF + mês atual + CNPJ de exemplo
 * (11.222.333/0001-81) + modelo 65 + série 1 + número 1 + emissão normal + código + dígito certo.
 * Com ela o portal responde como responderia a uma nota de verdade que não existe.
 */
export function chaveDeTeste(cUF: string, agora = new Date()): string {
  const aamm   = String(agora.getUTCFullYear()).slice(2) + String(agora.getUTCMonth() + 1).padStart(2, "0");
  const inicio = `${cUF}${aamm}11222333000181650010000000011` + "12345678";
  return inicio + digitoDaChave(inicio);
}

/** Chave de 44 números com o dígito verificador (44º) certo. */
export function chaveValida(chave: string): boolean {
  if (!/^\d{44}$/.test(chave)) return false;
  return digitoDaChave(chave.slice(0, 43)) === Number(chave[43]);
}

/** Raiz do CNPJ do emitente (8 dígitos), que fica nas posições 7 a 14 da chave. */
export function cnpjRaizDaChave(chave: string): string {
  return chave.slice(6, 14);
}

/** GTIN/EAN de 8, 12, 13 ou 14 dígitos com o dígito verificador certo. */
export function gtinValido(codigo: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(codigo)) return false;
  let soma = 0;
  for (let i = codigo.length - 2, j = 0; i >= 0; i--, j++) {
    soma += Number(codigo[i]) * (j % 2 === 0 ? 3 : 1);
  }
  return (10 - (soma % 10)) % 10 === Number(codigo[codigo.length - 1]);
}

/**
 * Código do produto a partir do item da nota. Código de barras de verdade fica como está;
 * código interno do fornecedor ("SEM GTIN", cProd) ganha a raiz do CNPJ na frente, senão o
 * "002" de um fornecedor casava com o "002" de outro.
 */
export function codigoDoItem(codigo: string, cnpjRaiz: string): string {
  const c = codigo.trim();
  if (!c || /^sem\s*gtin$/i.test(c)) return "";
  if (gtinValido(c)) return c;
  return cnpjRaiz ? `${cnpjRaiz}-${c}` : c;
}
