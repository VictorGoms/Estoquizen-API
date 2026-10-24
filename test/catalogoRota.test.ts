import { describe, it, expect, beforeEach, vi } from "vitest";
import { falso, montarApp, comoUsuario } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());
/* A SEFAZ simulada: nada sai da máquina */
vi.mock("../src/lib/nfce.js", async (original) => ({
  ...(await original<typeof import("../src/lib/nfce.js")>()),
  consultarNfce: vi.fn(async () => ({ oficial: true, itens: [
    { nome: "CARVAO FUMAX 1KG", quantidade: 1, unidade: "un", codigo: "7894900011517", valor_unitario: 10, valor_total: 10 },
    { nome: "SACOLA",           quantidade: 1, unidade: "un", codigo: "11222333-9",    valor_unitario: 0.1, valor_total: 0.1 },
  ] })),
}));

/* nfe.ts → nfceMonitor → resend.ts cria o cliente do Resend ao ser importado; nada é enviado aqui */
process.env.RESEND_API_KEY ??= "re_teste";
const { default: catalogoRoutes } = await import("../src/routes/v1/catalogo.js");
const { consultarNfce }           = await import("../src/lib/nfce.js");
const { default: nfeRoutes }      = await import("../src/routes/v1/nfe.js");

const GTIN = "7894900011517";
const WS   = "11111111-1111-4111-8111-111111111111";

describe("catálogo de códigos lê o que a SEFAZ mostrou (EQZ-60)", () => {
  beforeEach(() => falso.limpar());

  it("nome lido da SEFAZ é sugerido, e nota_imports não é mais consultada", async () => {
    falso.responder = (c) => c.tabela === "catalogo_sefaz" ? { data: [{ nome: "CARVAO FUMAX 1KG" }] } : { data: [] };
    const app = await montarApp(catalogoRoutes);
    const res = await app.inject({ method: "GET", url: `/api/v1/catalogo/${GTIN}`, headers: comoUsuario("alguem") });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ nome: "CARVAO FUMAX 1KG", fonte: "nota" });
    expect(falso.em("nota_imports")).toHaveLength(0);
  });

  it("nome digitado por uma empresa só continua sem aparecer", async () => {
    falso.responder = (c) => {
      if (c.tabela === "products")   return { data: [{ name: "teste do dono", workspace_id: WS }] };
      if (c.tabela === "workspaces") return { data: [{ id: WS, created_by: "ana" }] };
      return { data: [] };
    };
    const app = await montarApp(catalogoRoutes);
    const res = await app.inject({ method: "GET", url: `/api/v1/catalogo/${GTIN}`, headers: comoUsuario("alguem") });
    expect(res.json().data).toBeNull();
  });

  it("a consulta à SEFAZ grava no catálogo só os itens com código de barras de verdade", async () => {
    falso.responder = (c) => {
      if (c.tabela === "workspace_members") return { data: { role: "owner" } };
      if (c.tabela === "workspaces")        return { data: { plan: "pro" } };
      return undefined;
    };
    const chave = "29261011222333000181650010000000011123456786"; // chave de teste da BA (válida, de nota nenhuma)
    const app = await montarApp(nfeRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/v1/nfe/consultar", headers: comoUsuario("dono"),
      payload: { tipo: "nfce", chave, workspace_id: WS },
    });

    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(falso.em("catalogo_sefaz", "upsert")[0]?.dados).toEqual([{ codigo: GTIN, nome: "CARVAO FUMAX 1KG", uf: "29" }]);
  });

  it("página de um .gov.br que não é portal da SEFAZ (link do QR) não entra no catálogo", async () => {
    vi.mocked(consultarNfce).mockResolvedValueOnce({ oficial: false, itens: [
      { nome: "NOME INVENTADO", quantidade: 1, unidade: "un", codigo: GTIN, valor_unitario: 1, valor_total: 1 },
    ] });
    falso.responder = (c) => {
      if (c.tabela === "workspace_members") return { data: { role: "owner" } };
      if (c.tabela === "workspaces")        return { data: { plan: "pro" } };
      return undefined;
    };
    const app = await montarApp(nfeRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/v1/nfe/consultar", headers: comoUsuario("dono"),
      payload: { tipo: "nfce", chave: "29261011222333000181650010000000011123456786", workspace_id: WS,
                 qr_url: "https://prefeitura-qualquer.gov.br/arquivo.html?p=29261011222333000181650010000000011123456786|2|1" },
    });

    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(falso.em("catalogo_sefaz")).toHaveLength(0);
  });
});
