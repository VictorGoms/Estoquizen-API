import { describe, it, expect, beforeEach, vi } from "vitest";
import { criarIdempotencia, chaveDoHeader, JANELA_MS } from "../src/lib/idempotencia.js";
import { falso, montarApp, comoUsuario } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());

const { default: productsRoutes } = await import("../src/routes/v1/products.js");

describe("idempotência da entrada/saída (EQZ-67)", () => {
  it("a mesma chave executa uma vez só, mesmo com os dois pedidos ao mesmo tempo", async () => {
    const umaVez = criarIdempotencia();
    const executar = vi.fn(async () => ({ status: 200, corpo: { qty: 5 } }));
    const [a, b] = await Promise.all([umaVez("k", executar), umaVez("k", executar)]);
    expect(executar).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("erro não fica guardado: dá para corrigir e tentar de novo com a mesma chave", async () => {
    const umaVez = criarIdempotencia();
    await umaVez("k", async () => ({ status: 400, corpo: "Estoque insuficiente" }));
    const depois = await umaVez("k", async () => ({ status: 200, corpo: "ok" }));
    expect(depois.status).toBe(200);
  });

  it("passada a janela, a chave vale de novo; sem chave, executa sempre", async () => {
    let agora = 0;
    const umaVez = criarIdempotencia(() => agora);
    const executar = vi.fn(async () => ({ status: 200, corpo: null }));
    await umaVez("k", executar);
    agora = JANELA_MS + 1;
    await umaVez("k", executar);
    await umaVez(undefined, executar);
    await umaVez(undefined, executar);
    expect(executar).toHaveBeenCalledTimes(4);
  });

  it("só aceita chave de header curta", () => {
    expect(chaveDoHeader("abc")).toBe("abc");
    expect(chaveDoHeader("x".repeat(101))).toBeUndefined();
    expect(chaveDoHeader(["a", "b"])).toBeUndefined();
    expect(chaveDoHeader(undefined)).toBeUndefined();
  });
});

describe("POST /products/:id/adjust com Idempotency-Key", () => {
  const PRODUTO = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    falso.limpar();
    falso.responder = (c) => {
      if (c.tabela === "products")      return { data: { workspace_id: "ws1" } };
      if (c.tabela === "subscriptions") return { data: { status: "active", trial_ends_at: null, pause_starts_at: null, pause_ends_at: null } };
      return undefined;
    };
    falso.cliente.rpc.mockResolvedValue({ data: { qty: 7 }, error: null } as never);
  });

  it("dois toques com a mesma chave gravam uma entrada só", async () => {
    const app = await montarApp(productsRoutes);
    const pedido = () => app.inject({
      method: "POST", url: `/api/v1/products/${PRODUTO}/adjust`,
      headers: { ...comoUsuario("membro"), "idempotency-key": "toque-1" },
      payload: { delta: 1 },
    });
    const [a, b] = await Promise.all([pedido(), pedido()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(falso.cliente.rpc).toHaveBeenCalledTimes(1);
  });

  it("sem a chave, cada pedido grava (o comportamento de antes)", async () => {
    const app = await montarApp(productsRoutes);
    const pedido = () => app.inject({
      method: "POST", url: `/api/v1/products/${PRODUTO}/adjust`, headers: comoUsuario("membro"), payload: { delta: 1 },
    });
    await pedido();
    await pedido();
    expect(falso.cliente.rpc).toHaveBeenCalledTimes(2);
  });
});
