import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { falso, montarApp, type Consulta } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());

/* resend.ts e stripe.ts criam os clientes ao serem importados; nada é enviado aqui */
process.env.RESEND_API_KEY    ??= "re_teste";
process.env.STRIPE_SECRET_KEY ??= "sk_test_teste";
const { stripe }                 = await import("../src/lib/stripe.js");
const { default: webhookRoutes } = await import("../src/routes/webhooks.js");

const SEGREDO = "whsec_" + "t".repeat(32);
const WS      = "11111111-1111-4111-8111-111111111111";

const evento = (type: string, object: unknown, id = "evt_1") =>
  JSON.stringify({ id, object: "event", type, data: { object } });

const assinar = (corpo: string, segredo: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", segredo).update(`${t}.${corpo}`).digest("hex")}`;
};

async function enviar(corpo: string, assinatura?: string) {
  const app = await montarApp(webhookRoutes, "");
  return app.inject({
    method: "POST", url: "/webhooks/stripe", payload: corpo,
    headers: { "content-type": "application/json", ...(assinatura ? { "stripe-signature": assinatura } : {}) },
  });
}

const checkoutPro = evento("checkout.session.completed", {
  object: "checkout.session", payment_status: "paid", metadata: { workspace_id: WS, plan: "pro" }, customer: "cus_1",
});

const gravouAtivo = () => falso.em("subscriptions", "update").some((c) => (c.dados as { status?: string }).status === "active");

describe("webhook do Stripe: quem não é o Stripe não entra (EQZ-55)", () => {
  beforeEach(() => {
    falso.limpar();
    process.env.STRIPE_WEBHOOK_SECRET = SEGREDO;
  });

  it("sem STRIPE_WEBHOOK_SECRET recusa tudo (503), mesmo assinado com chave vazia", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await enviar(checkoutPro, assinar(checkoutPro, ""));
    expect(res.statusCode).toBe(503);
    expect(falso.chamadas).toHaveLength(0);
  });

  it("Postman sem assinatura → 400", async () => {
    expect((await enviar(checkoutPro)).statusCode).toBe(400);
    expect(gravouAtivo()).toBe(false);
  });

  it("assinatura com chave vazia ou inventada → 400", async () => {
    expect((await enviar(checkoutPro, assinar(checkoutPro, ""))).statusCode).toBe(400);
    expect((await enviar(checkoutPro, assinar(checkoutPro, "whsec_outro"))).statusCode).toBe(400);
    expect(gravouAtivo()).toBe(false);
  });

  it("assinado com o segredo certo → ativa o plano", async () => {
    const res = await enviar(checkoutPro, assinar(checkoutPro, SEGREDO));
    expect(res.statusCode).toBe(200);
    expect(gravouAtivo()).toBe(true);
  });
});

describe("webhook do Stripe: repetição e ordem dos eventos (EQZ-59)", () => {
  beforeEach(() => {
    falso.limpar();
    process.env.STRIPE_WEBHOOK_SECRET = SEGREDO;
  });

  it("evento repetido não é processado de novo", async () => {
    falso.responder = (c: Consulta) =>
      c.tabela === "stripe_events" && c.op === "insert" ? { error: { message: "duplicate key", code: "23505" } } : undefined;
    const res = await enviar(checkoutPro, assinar(checkoutPro, SEGREDO));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repetido: true });
    expect(falso.em("subscriptions")).toHaveLength(0);
  });

  it("falha ao gravar → 500 e o registro do evento sai, para o reenvio processar", async () => {
    falso.responder = (c: Consulta) =>
      c.tabela === "subscriptions" && c.op === "update" ? { error: { message: "falhou" } } : undefined;
    const res = await enviar(checkoutPro, assinar(checkoutPro, SEGREDO));
    expect(res.statusCode).toBe(500);
    expect(falso.em("stripe_events", "delete")).toHaveLength(1);
  });

  it("'updated' antigo chegando depois do cancelamento não reativa: vale o estado atual no Stripe", async () => {
    vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue({
      id: "sub_1", status: "canceled", metadata: { workspace_id: WS, plan: "pro" }, cancel_at_period_end: false, cancel_at: null,
      pause_collection: null, items: { data: [{ price: { id: "price_x" }, current_period_end: 1 }] },
    } as never);
    falso.responder = (c: Consulta) =>
      c.tabela === "subscriptions" && c.op === "select" ? { data: { stripe_subscription_id: "sub_1", status: "canceled" } } : undefined;

    const velho = evento("customer.subscription.updated", { id: "sub_1", object: "subscription", status: "active", metadata: { workspace_id: WS } }, "evt_velho");
    const res = await enviar(velho, assinar(velho, SEGREDO));

    expect(res.statusCode).toBe(200);
    const gravado = falso.em("subscriptions", "update")[0]?.dados as { status?: string };
    expect(gravado.status).toBe("canceled");
  });

  it("fatura paga de uma 2ª assinatura não toma o lugar da que está ativa", async () => {
    vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue({
      id: "sub_2", status: "active", metadata: { workspace_id: WS, plan: "basic" }, items: { data: [{ price: { id: "price_b" }, current_period_end: 1 }] },
    } as never);
    falso.responder = (c: Consulta) =>
      c.tabela === "subscriptions" && c.op === "select" ? { data: { stripe_subscription_id: "sub_1", status: "active" } } : undefined;

    const fatura = evento("invoice.paid", { object: "invoice", customer: "cus_1", parent: { subscription_details: { subscription: "sub_2" } } }, "evt_fatura");
    const res = await enviar(fatura, assinar(fatura, SEGREDO));

    expect(res.statusCode).toBe(200);
    expect(falso.em("subscriptions", "update")).toHaveLength(0);
  });
});
