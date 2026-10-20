import { describe, it, expect } from "vitest";
import "../src/lib/zodPt.js";
import { CancelFeedbackSchema } from "../src/schemas/billing.schema.js";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema, SEGMENTOS } from "../src/schemas/workspace.schema.js";
import { ImportProductsSchema, CreateProductSchema } from "../src/schemas/product.schema.js";

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
