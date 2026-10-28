/*
 * Teste grátis. Lançamento (decisão do João em 2026-10-28; substitui os 30 dias de 2026-10-21): todos os planos
 * de graça até 05/01/2027, inclusive, para vender sem CNPJ; a cobrança começa em 06/01. Quem começar perto da
 * data (a partir de 23/12) ganha pelo menos DIAS_MINIMOS. Depois de 05/01, todo cadastro novo tem DIAS_MINIMOS.
 * Os textos ficam no front (`src/lib/teste.ts`): depois de 05/01, trocar lá para o teste normal.
 * 1 teste por conta, por CPF e por e-mail normalizado (trial_grants), em POST /workspaces.
 */
import { createHash } from "node:crypto";
export const GRATIS_ATE   = new Date("2027-01-06T03:00:00Z");   // 06/01/2027 00:00 em Brasília
export const DIAS_MINIMOS = 14;

export function fimDoTeste(inicio: Date = new Date()): Date {
  const minimo = new Date(inicio.getTime() + DIAS_MINIMOS * 24 * 60 * 60 * 1000);
  return minimo > GRATIS_ATE ? minimo : GRATIS_ATE;
}

/*
 * E-mail como a caixa de entrada vê (pedido do João em 2026-10-28): sem o "+qualquercoisa" e, no Gmail, sem os
 * pontos. Sem isso, "joao+1@gmail.com", "joao+2@gmail.com" e "j.oao@gmail.com" eram 3 contas com 3 testes, e
 * todas caem na mesma caixa. A mesma regra está no SQL da migração 20261028140000 (preenchimento dos antigos).
 */
export function normalizarEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const arroba = e.indexOf("@");
  if (arroba < 0) return e;
  let local   = e.slice(0, arroba).split("+")[0];
  let dominio = e.slice(arroba + 1);
  if (dominio === "gmail.com" || dominio === "googlemail.com") {
    local   = local.replaceAll(".", "");
    dominio = "gmail.com";
  }
  return `${local}@${dominio}`;
}

/** SHA-256 do e-mail normalizado: o que vai para trial_grants.email_hash (como o CPF, só o hash) */
export const hashEmailDoTeste = (email: string) =>
  createHash("sha256").update(normalizarEmail(email)).digest("hex");
