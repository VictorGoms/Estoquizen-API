import { describe, it, expect, beforeEach, vi } from "vitest";
import { falso, montarApp, comoUsuario } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());
/* Nenhum e-mail sai nos testes */
vi.mock("../src/lib/resend.js", async (original) => ({
  ...(await original<typeof import("../src/lib/resend.js")>()),
  sendWithdrawalEmail:     vi.fn(async () => undefined),
  sendManualRefundEmail:   vi.fn(async () => undefined),
  sendPauseScheduledEmail: vi.fn(async () => undefined),
}));

/* resend.ts e stripe.ts criam os clientes ao serem importados; nada é enviado aqui */
process.env.RESEND_API_KEY    ??= "re_teste";
process.env.STRIPE_SECRET_KEY ??= "sk_test_teste";
const { stripe }                 = await import("../src/lib/stripe.js");
const { default: billingRoutes } = await import("../src/routes/v1/billing.js");

const WS   = "11111111-1111-4111-8111-111111111111";
const DONO = "dono";

describe("POST /billing/portal: sem troca de plano (EQZ-57)", () => {
  beforeEach(() => {
    falso.limpar();
    falso.responder = (c) => {
      if (c.tabela === "workspace_members") return { data: c.filtros.user_id === DONO ? { role: "owner" } : null };
      if (c.tabela === "subscriptions")     return { data: { stripe_customer_id: "cus_1" } };
      return undefined;
    };
  });

  it("abre o portal com a configuração que não deixa trocar de plano", async () => {
    process.env.STRIPE_PORTAL_CONFIG_GERAL = "bpc_sem_troca";
    const criar = vi.spyOn(stripe.billingPortal.sessions, "create").mockResolvedValue({ url: "https://portal" } as never);

    const app = await montarApp(billingRoutes);
    const res = await app.inject({ method: "POST", url: "/api/v1/billing/portal", headers: comoUsuario(DONO), payload: { workspace_id: WS } });

    expect(res.statusCode).toBe(200);
    expect(criar).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1", configuration: "bpc_sem_troca" }));
  });

  it("só o dono abre o portal", async () => {
    const criar = vi.spyOn(stripe.billingPortal.sessions, "create");
    const app = await montarApp(billingRoutes);
    const res = await app.inject({ method: "POST", url: "/api/v1/billing/portal", headers: comoUsuario("outro"), payload: { workspace_id: WS } });
    expect(res.statusCode).toBe(404);
    expect(criar).not.toHaveBeenCalled();
  });
});

describe("POST /billing/desistir: 1 vez por pessoa, também com pedidos ao mesmo tempo (EQZ-58)", () => {
  let reserva: { error?: { message: string; code?: string }; data?: unknown };

  beforeEach(() => {
    falso.limpar();
    reserva = { data: { id: "r1" } };
    falso.responder = (c) => {
      if (c.tabela === "workspace_members") return { data: c.filtros.user_id === DONO ? { role: "owner" } : null };
      if (c.tabela === "subscriptions" && c.op === "select") return { data: { stripe_subscription_id: "sub_1", status: "active" } };
      if (c.tabela === "profiles")      return { data: { cpf: null } };
      if (c.tabela === "desistencias" && c.op === "select") return { count: 0 };
      if (c.tabela === "desistencias" && c.op === "insert") return reserva;
      return undefined;
    };
    vi.spyOn(stripe.invoices, "list").mockResolvedValue({
      data: [{ id: "in_1", amount_paid: 2490, status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 86400 } }],
    } as never);
  });

  const desistir = async () => {
    const app = await montarApp(billingRoutes);
    return app.inject({ method: "POST", url: "/api/v1/billing/desistir", headers: comoUsuario(DONO), payload: { workspace_id: WS } });
  };

  it("o segundo pedido ao mesmo tempo para na reserva e não devolve nada", async () => {
    reserva = { error: { message: "duplicate key value", code: "23505" } };
    const estornar = vi.spyOn(stripe.refunds, "create");

    const res = await desistir();

    expect(res.statusCode).toBe(409);
    expect(estornar).not.toHaveBeenCalled();
  });

  it("a reserva vem antes do estorno e, se o estorno quebra no meio, ela sai", async () => {
    vi.spyOn(stripe.invoicePayments, "list").mockRejectedValue(new Error("Stripe fora do ar"));

    const res = await desistir();

    expect(res.statusCode).toBe(502);
    expect(falso.em("desistencias", "insert")).toHaveLength(1);
    expect(falso.em("desistencias", "delete")).toHaveLength(1);
  });

  it("deu tudo certo: devolve, cancela e grava os valores na reserva", async () => {
    vi.spyOn(stripe.invoicePayments, "list").mockResolvedValue({
      data: [{ amount_paid: 2490, payment: { type: "payment_intent", payment_intent: "pi_1" } }],
    } as never);
    vi.spyOn(stripe.refunds, "create").mockResolvedValue({ amount: 2490 } as never);
    vi.spyOn(stripe.subscriptions, "cancel").mockResolvedValue({} as never);

    const res = await desistir();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ devolvido: 2490, manual: 0 });
    expect(falso.em("desistencias", "update")[0]?.dados).toEqual({ devolvido: 2490, manual: 0 });
    expect(falso.em("desistencias", "delete")).toHaveLength(0);
  });
});

describe("GET /billing/subscription: só o necessário, ids do Stripe só para o dono (EQZ-66)", () => {
  const linha = {
    status: "active", plan: "growth", trial_ends_at: null, current_period_end: "2026-11-28T00:00:00Z",
    cancel_at_period_end: false, expired_at: null, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
    pause_starts_at: null, pause_ends_at: null,
  };

  beforeEach(() => {
    falso.limpar();
    falso.responder = (c) => {
      if (c.tabela === "workspace_members") {
        const papel = c.filtros.user_id === DONO ? "owner" : c.filtros.user_id === "admin" ? "admin" : null;
        return { data: papel ? { role: papel } : null };
      }
      if (c.tabela === "subscriptions" && c.op === "select") return { data: linha };
      return undefined;
    };
  });

  const consultar = async (quem: string) => {
    const app = await montarApp(billingRoutes);
    return app.inject({ method: "GET", url: `/api/v1/billing/subscription?workspace_id=${WS}`, headers: comoUsuario(quem) });
  };

  it("o dono recebe os ids do Stripe e a pausa disponível", async () => {
    const res = await consultar(DONO);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", pausa_disponivel: true });
  });

  it("o admin vê o status, mas não os ids do Stripe", async () => {
    const res = await consultar("admin");
    expect(res.json().data).toMatchObject({ status: "active", plan: "growth", stripe_customer_id: null, stripe_subscription_id: null });
  });

  it("não vão as marcas internas (e-mails, avisos)", async () => {
    const res = await consultar(DONO);
    const dados = res.json().data as Record<string, unknown>;
    for (const interno of ["confirmation_email_sub_id", "warned_at", "final_warned_at", "trial_recap_sent_at", "workspace_id"]) {
      expect(dados).not.toHaveProperty(interno);
    }
  });
});
