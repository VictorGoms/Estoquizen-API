import { describe, it, expect, beforeEach, vi } from "vitest";
import { falso, montarApp, comoUsuario } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());

/* resend.ts e stripe.ts criam os clientes ao serem importados; nada é enviado aqui */
process.env.RESEND_API_KEY    ??= "re_teste";
process.env.STRIPE_SECRET_KEY ??= "sk_test_teste";
const { default: workspacesRoutes } = await import("../src/routes/v1/workspaces.js");
const { hashEmailDoTeste }          = await import("../src/lib/trial.js");

const DONO     = "dono";
const PARADO   = "22222222-2222-4222-8222-222222222222";
const CPF_TESTE = "52998224725";   // CPF de exemplo com dígitos válidos

const criar = async () => {
  const app = await montarApp(workspacesRoutes);
  return app.inject({
    method: "POST", url: "/api/v1/workspaces", headers: comoUsuario(DONO),
    payload: { name: "Loja Nova", plan: "growth", cpf: CPF_TESTE },
  });
};

describe("no máximo 1 workspace esperando pagamento por pessoa (2026-10-28)", () => {
  beforeEach(() => falso.limpar());

  it("com um workspace sem teste e nunca pago, recusa criar outro e não grava nada", async () => {
    falso.responder = (c) => {
      if (c.tabela === "workspaces" && c.op === "select") return { data: [{ id: PARADO, name: "Loja Parada" }] };
      if (c.tabela === "subscriptions" && c.op === "select") return { data: { workspace_id: PARADO } };
    };
    const res = await criar();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`"Loja Parada" esperando pagamento`);
    expect(falso.em("workspaces", "insert")).toHaveLength(0);
    expect(falso.em("trial_grants", "insert")).toHaveLength(0);

    /* "Esperando pagamento" = nasceu sem teste, bloqueado e sem assinatura no Stripe */
    const [sub] = falso.em("subscriptions", "select");
    expect(sub.filtros).toMatchObject({
      "workspace_id:in": [PARADO], status: "trial_expired", "trial_ends_at:is": null, "stripe_subscription_id:is": null,
    });
  });

  it("sem workspace pendente, cria normalmente (com o teste, se a pessoa ainda não usou)", async () => {
    falso.responder = (c) => {
      if (c.tabela === "workspaces" && c.op === "select")  return { data: [] };
      if (c.tabela === "workspaces" && c.op === "insert")  return { data: { id: "novo", name: "Loja Nova" } };
    };
    const res = await criar();

    expect(res.statusCode).toBe(201);
    expect(res.json().data.trial).toBe(true);
    const [sub] = falso.em("subscriptions", "insert");
    expect(sub.dados).toMatchObject({ workspace_id: "novo", status: "trialing" });
    /* O teste fica preso também ao e-mail normalizado da conta (o falso dá "dono@teste") */
    const [grant] = falso.em("trial_grants", "insert");
    expect(grant.dados).toMatchObject({ user_id: DONO, email_hash: hashEmailDoTeste("dono@teste") });
  });

  it("e-mail já usado em outro teste (índice único): cria sem teste e abre o pagamento", async () => {
    falso.responder = (c) => {
      if (c.tabela === "workspaces" && c.op === "select")  return { data: [] };
      if (c.tabela === "workspaces" && c.op === "insert")  return { data: { id: "novo", name: "Loja Nova" } };
      if (c.tabela === "trial_grants" && c.op === "insert") return { error: { message: "duplicate key", code: "23505" } };
    };
    const res = await criar();

    expect(res.statusCode).toBe(201);
    expect(res.json().data.trial).toBe(false);
    expect(falso.em("subscriptions", "insert")[0].dados).toMatchObject({ status: "trial_expired", trial_ends_at: null });
  });
});

describe("GET /workspaces/teste-disponivel", () => {
  beforeEach(() => falso.limpar());

  const consultar = async () => {
    const app = await montarApp(workspacesRoutes);
    return app.inject({ method: "GET", url: "/api/v1/workspaces/teste-disponivel", headers: comoUsuario(DONO) });
  };

  it("quem já usou o teste vê disponivel: false e o workspace pendente", async () => {
    falso.responder = (c) => {
      if (c.tabela === "trial_grants")  return { data: { user_id: DONO } };
      if (c.tabela === "workspaces")    return { data: [{ id: PARADO, name: "Loja Parada" }] };
      if (c.tabela === "subscriptions") return { data: { workspace_id: PARADO } };
    };
    const res = await consultar();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ disponivel: false, pendente: { id: PARADO, name: "Loja Parada" } });
    /* Pela conta ou pelo e-mail normalizado dela; nada de CPF nessa rota */
    expect(falso.em("trial_grants")[0].filtros).toEqual({ ":or": `user_id.eq.${DONO},email_hash.eq.${hashEmailDoTeste("dono@teste")}` });
  });

  it("conta nova: teste disponível e nada pendente", async () => {
    falso.responder = (c) => (c.tabela === "workspaces" ? { data: [] } : undefined);
    const res = await consultar();
    expect(res.json().data).toEqual({ disponivel: true, pendente: null });
  });

  it("sem login, 401", async () => {
    const app = await montarApp(workspacesRoutes);
    const res = await app.inject({ method: "GET", url: "/api/v1/workspaces/teste-disponivel" });
    expect(res.statusCode).toBe(401);
  });
});
