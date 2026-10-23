/**
 * EQZ-50: desistência em até 7 dias do 1º pagamento da assinatura (CDC art. 49; Decreto 7.962,
 * art. 5º), como prometem os Termos (seção 6), o resumo antes do pagamento e o e-mail "Assinatura
 * confirmada". Devolve tudo o que a assinatura pagou (o 1º pagamento e uma troca de plano feita no
 * prazo) e cancela na hora. Uma assinatura nova tem o seu próprio prazo.
 */
export const DIAS_DESISTENCIA = 7;

export interface FaturaPaga {
  id:     string;
  /** Centavos */
  valor:  number;
  /** Segundos, como o Stripe manda */
  pagaEm: number;
}

/** Até quando dá para desistir (ms), contado do 1º pagamento; null se a assinatura nunca cobrou nada. */
export function prazoDaDesistencia(faturas: FaturaPaga[]): number | null {
  if (!faturas.length) return null;
  const primeira = Math.min(...faturas.map((f) => f.pagaEm));
  return primeira * 1000 + DIAS_DESISTENCIA * 24 * 60 * 60 * 1000;
}

/** Quanto volta na desistência: tudo o que a assinatura pagou (centavos). */
export const totalPago = (faturas: FaturaPaga[]) => faturas.reduce((soma, f) => soma + f.valor, 0);
