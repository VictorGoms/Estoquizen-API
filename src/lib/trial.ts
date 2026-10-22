/*
 * Teste grátis (decisão do João em 2026-10-21, oferta de lançamento): 30 dias em todos os planos,
 * Pro incluído (para verem o histórico por funcionário), para quem criar a empresa até 30/11/2026.
 * Em 01/12 o João decide se volta para 14: mudar aqui e no front (`src/lib/teste.ts` + textos).
 * Se ninguém mudar, continua 30, que é o lado generoso.
 * 1 teste por pessoa e por CPF (trial_grants), em POST /workspaces.
 */
export const DIAS_TESTE = 30;

export function fimDoTeste(inicio: Date = new Date()): Date {
  return new Date(inicio.getTime() + DIAS_TESTE * 24 * 60 * 60 * 1000);
}
