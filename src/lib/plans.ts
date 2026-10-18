/**
 * Limites por plano do Estoquizen.
 * Fonte única de verdade — alterar aqui reflete em todas as validações.
 */

export type Plan = "basic" | "growth" | "pro";

interface PlanLimits {
  label:        string;
  products:     number;
  members:      number;
  dailyInvites: number; // convites enviados por dia por workspace
  price:        number; // R$/mês
  notasPorMes:  number | null; // ler nota de compra (NFC-e/XML) por mês; null = sem limite
  metricasDias: number;        // até quantos dias as métricas mostram (aplicado no front)
}

/* Planos fechados pelo João em 2026-10-17 (EQZ-27): equipe 3/10/sem limite, ler nota 2 por mês
   no Basic e métricas de 30 dias / 3 meses / 12 meses. Os preços novos dependem do Stripe. */

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  basic: {
    label:        "Basic",
    products:     50,
    members:      3,
    dailyInvites: 10,
    price:        19.90,
    notasPorMes:  2,
    metricasDias: 30,
  },
  growth: {
    label:        "Growth",
    products:     300,
    members:      10,
    dailyInvites: 25,
    price:        29.90,
    notasPorMes:  null,
    metricasDias: 90,
  },
  pro: {
    label:        "Pro",
    products:     2000,
    members:      Number.POSITIVE_INFINITY, // sem limite de equipe; o limite técnico é dailyInvites
    dailyInvites: 50,
    price:        59.90,
    notasPorMes:  null,
    metricasDias: 365,
  },
};

export function getLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.basic;
}
