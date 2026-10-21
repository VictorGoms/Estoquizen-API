/* Pausa da assinatura (EQZ-07). Regra pura, sem banco: usada pela API e pelos testes. */

/** Está dentro do período bloqueado da pausa? (mesma regra do workspace_is_writable do banco) */
export function pausaEmAndamento(
  sub: { pause_starts_at?: string | null; pause_ends_at?: string | null },
  agora = Date.now(),
): boolean {
  if (!sub.pause_starts_at || !sub.pause_ends_at) return false;
  return agora >= new Date(sub.pause_starts_at).getTime() && agora < new Date(sub.pause_ends_at).getTime();
}

/** Soma meses de calendário a um instante em segundos (como o ciclo mensal do Stripe). */
export function somarMeses(segundos: number, meses: number): number {
  const d = new Date(segundos * 1000);
  d.setUTCMonth(d.getUTCMonth() + meses);
  return Math.floor(d.getTime() / 1000);
}
