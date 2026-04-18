/**
 * Limites por plano do Estoquizen.
 * Fonte única de verdade — alterar aqui reflete em todas as validações.
 */

export type Plan = "basic" | "intermediate" | "pro";

interface PlanLimits {
  label:        string;
  products:     number;
  members:      number;
  dailyInvites: number; // convites enviados por dia por workspace
  price:        number; // R$/mês
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  basic: {
    label:        "Basic",
    products:     150,
    members:      3,
    dailyInvites: 10,
    price:        39,
  },
  intermediate: {
    label:        "Growth",
    products:     500,
    members:      7,
    dailyInvites: 25,
    price:        69,
  },
  pro: {
    label:        "Pro",
    products:     2000,
    members:      12,
    dailyInvites: 50,
    price:        129,
  },
};

export function getLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.basic;
}
