import { describe, it, expect } from "vitest";
import "../src/lib/zodPt.js";
import { CancelFeedbackSchema } from "../src/schemas/billing.schema.js";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema, SEGMENTOS } from "../src/schemas/workspace.schema.js";
import { ImportProductsSchema, CreateProductSchema, AdjustBatchSchema } from "../src/schemas/product.schema.js";
import { ShoppingItemSchema } from "../src/schemas/shopping.schema.js";

const WS = "11111111-1111-4111-8111-111111111111";

describe("cancelamento (EQZ-07)", () => {
  it("aceita motivo e ação conhecidos, e limpa o detalhe", () => {
    const r = CancelFeedbackSchema.safeParse({ workspace_id: WS, motivo: "caro", acao: "pausar", detalhe: " <b>caro</b> demais " });
    expect(r.success).toBe(true);
    expect(r.success && r.data.detalhe).toBe("caro demais");
  });
  it("recusa motivo, ação ou workspace inválidos", () => {
    expect(CancelFeedbackSchema.safeParse({ workspace_id: WS, motivo: "xyz", acao: "cancelar" }).success).toBe(false);
    expect(CancelFeedbackSchema.safeParse({ workspace_id: WS, motivo: "caro", acao: "excluir" }).success).toBe(false);
    expect(CancelFeedbackSchema.safeParse({ workspace_id: "abc", motivo: "caro", acao: "cancelar" }).success).toBe(false);
    expect(CancelFeedbackSchema.safeParse({ workspace_id: WS, motivo: "outro", acao: "cancelar", detalhe: "x".repeat(501) }).success).toBe(false);
  });
});

describe("ramo do workspace (EQZ-13)", () => {
  it("os valores batem com o CHECK do banco", () => {
    expect([...SEGMENTOS]).toEqual(["mercearia", "bar", "buffet", "roupas", "pet", "oficina", "outro"]);
  });
  it("criar aceita o ramo e o texto do Outro; ramo desconhecido é recusado", () => {
    expect(CreateWorkspaceSchema.safeParse({ name: "Bar do Zé", segment: "bar" }).success).toBe(true);
    const outro = CreateWorkspaceSchema.safeParse({ name: "Papelaria X", segment: "outro", segment_other: "papelaria".repeat(10) });
    expect(outro.success && outro.data.segment_other?.length).toBe(60);
    expect(CreateWorkspaceSchema.safeParse({ name: "X Y", segment: "farmacia" }).success).toBe(false);
  });
  it("editar aceita limpar o ramo", () => {
    expect(UpdateWorkspaceSchema.safeParse({ segment: null, segment_other: null }).success).toBe(true);
  });
});

describe("produtos", () => {
  it("importação: até 2000 itens, nome com 2+ letras", () => {
    expect(ImportProductsSchema.safeParse({ workspace_id: WS, itens: [{ name: "Arroz", unit: "un", min_qty: 5, qty: 0 }] }).success).toBe(true);
    expect(ImportProductsSchema.safeParse({ workspace_id: WS, itens: [{ name: "A" }] }).success).toBe(false);
    expect(ImportProductsSchema.safeParse({ workspace_id: WS, itens: [] }).success).toBe(false);
  });
  it("ícone escolhido à mão: só a chave em minúsculas (EQZ-30)", () => {
    const base = { workspace_id: WS, name: "Queijo", unit: "kg", price: 39.9 };
    expect(CreateProductSchema.safeParse({ ...base, icon: "queijo" }).success).toBe(true);
    expect(CreateProductSchema.safeParse({ ...base, icon: null }).success).toBe(true);
    expect(CreateProductSchema.safeParse({ ...base, icon: "Queijo!" }).success).toBe(false);
  });
});

describe("lista de compras (itens à mão)", () => {
  const P = "22222222-2222-4222-8222-222222222222";
  it("aceita quantidade positiva e arredonda em 3 casas", () => {
    const r = ShoppingItemSchema.safeParse({ workspace_id: WS, product_id: P, qty: 1.23456 });
    expect(r.success && r.data.qty).toBe(1.235);
  });
  it("recusa zero, negativo e produto inválido", () => {
    expect(ShoppingItemSchema.safeParse({ workspace_id: WS, product_id: P, qty: 0 }).success).toBe(false);
    expect(ShoppingItemSchema.safeParse({ workspace_id: WS, product_id: P, qty: -2 }).success).toBe(false);
    expect(ShoppingItemSchema.safeParse({ workspace_id: WS, product_id: "abc", qty: 2 }).success).toBe(false);
  });
});

describe("vários produtos de uma vez (EQZ-69)", () => {
  const P1 = "22222222-2222-4222-8222-222222222222";
  const P2 = "33333333-3333-4333-8333-333333333333";
  const lote = (itens: unknown[], extra = {}) => AdjustBatchSchema.safeParse({ workspace_id: WS, tipo: "saida", itens, ...extra });

  it("aceita a lista e arredonda a quantidade em 3 casas", () => {
    const r = lote([{ product_id: P1, qty: 2 }, { product_id: P2, qty: 0.12345 }], { motivo: "perda" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.itens[1].qty).toBe(0.123);
  });

  it("recusa lista vazia, produto repetido e quantidade zero ou negativa", () => {
    expect(lote([]).success).toBe(false);
    expect(lote([{ product_id: P1, qty: 1 }, { product_id: P1, qty: 2 }]).success).toBe(false);
    expect(lote([{ product_id: P1, qty: 0 }]).success).toBe(false);
    expect(lote([{ product_id: P1, qty: -3 }]).success).toBe(false);
  });

  it("recusa tipo e motivo desconhecidos", () => {
    expect(lote([{ product_id: P1, qty: 1 }], { tipo: "troca" }).success).toBe(false);
    expect(lote([{ product_id: P1, qty: 1 }], { motivo: "presente" }).success).toBe(false);
  });

  it("até 300 produtos por vez", () => {
    const muitos = Array.from({ length: 301 }, (_, i) => ({ product_id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`, qty: 1 }));
    expect(lote(muitos).success).toBe(false);
    expect(lote(muitos.slice(0, 300)).success).toBe(true);
  });
});
