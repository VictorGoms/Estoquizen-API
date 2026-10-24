import { describe, it, expect, beforeEach, vi } from "vitest";
import { falso, montarApp, comoUsuario } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());

/* nfe.ts → nfceMonitor → resend.ts cria o cliente do Resend ao ser importado; nada é enviado aqui */
process.env.RESEND_API_KEY ??= "re_teste";
const { default: productsRoutes } = await import("../src/routes/v1/products.js");
const { default: nfeRoutes }      = await import("../src/routes/v1/nfe.js");
const { listaGrandeDemais }       = await import("../src/lib/sanitize.js");

const WS = "11111111-1111-4111-8111-111111111111";
const corpoCom = (n: number) => `{"workspace_id":"${WS}","tipo":"xml","itens":[${Array(n).fill("{}").join(",")}]}`;

describe("lista enorme não chega ao zod (EQZ-59)", () => {
  beforeEach(() => falso.limpar());

  it("listaGrandeDemais confere só o tamanho", () => {
    expect(listaGrandeDemais({ itens: Array(3) }, "itens", 2)).toBe(true);
    expect(listaGrandeDemais({ itens: Array(2) }, "itens", 2)).toBe(false);
    expect(listaGrandeDemais({ itens: "x" }, "itens", 2)).toBe(false);
    expect(listaGrandeDemais(null, "itens", 2)).toBe(false);
  });

  it("planilha com 1 milhão de itens (2,9 MB) é recusada na hora, sem validar item por item", async () => {
    const app = await montarApp(productsRoutes);
    const inicio = Date.now();
    const res = await app.inject({
      method: "POST", url: "/api/v1/products/import", payload: corpoCom(1_000_000),
      headers: { ...comoUsuario("qualquer"), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Importe até 2000 produtos por vez");
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(falso.chamadas).toHaveLength(0);
  });

  it("nota com mais de 500 itens é recusada antes do schema", async () => {
    const app = await montarApp(nfeRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/v1/nfe/importar", payload: corpoCom(300_000),
      headers: { ...comoUsuario("qualquer"), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Nota com itens demais");
    expect(falso.chamadas).toHaveLength(0);
  });
});
