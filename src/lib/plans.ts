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
  nfe:          boolean; // importação de nota (NFC-e e XML) — a tela de planos promete só no Growth e no Pro
  metricas:     boolean; // relatórios e análises (/dashboard-metricas, aplicado no front)
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  basic: {
    label:        "Basic",
    products:     50,
    members:      3,
    dailyInvites: 10,
    price:        19.90,
    nfe:          false,
    metricas:     false,
  },
  growth: {
    label:        "Growth",
    products:     300,
    members:      7,
    dailyInvites: 25,
    price:        29.90,
    nfe:          true,
    metricas:     true,
  },
  pro: {
    label:        "Pro",
    products:     2000,
    members:      12,
    dailyInvites: 50,
    price:        59.90,
    nfe:          true,
    metricas:     true,
  },
};

export function getLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.basic;
}
