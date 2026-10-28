/*
 * Teste grátis. Lançamento (decisão do João em 2026-10-28; substitui os 30 dias de 2026-10-21): todos os planos
 * de graça até 05/01/2027, inclusive, para vender sem CNPJ; a cobrança começa em 06/01. Quem começar perto da
 * data (a partir de 23/12) ganha pelo menos DIAS_MINIMOS. Depois de 05/01, todo cadastro novo tem DIAS_MINIMOS.
 * Os textos ficam no front (`src/lib/teste.ts`): depois de 05/01, trocar lá para o teste normal.
 * 1 teste por pessoa e por CPF (trial_grants), em POST /workspaces.
 */
export const GRATIS_ATE   = new Date("2027-01-06T03:00:00Z");   // 06/01/2027 00:00 em Brasília
export const DIAS_MINIMOS = 14;

export function fimDoTeste(inicio: Date = new Date()): Date {
  const minimo = new Date(inicio.getTime() + DIAS_MINIMOS * 24 * 60 * 60 * 1000);
  return minimo > GRATIS_ATE ? minimo : GRATIS_ATE;
}
