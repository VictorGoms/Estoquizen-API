import { describe, it, expect } from "vitest";
import { nomeSugerido, normalizarNome, linhasDoCatalogo } from "../src/lib/catalogo.js";

describe("catálogo próprio de códigos de barras (EQZ-53)", () => {
  it("nome digitado por uma empresa só não aparece para as outras (pode ser teste)", () => {
    expect(nomeSugerido([{ nome: "nada a ver", dono: "ana", daNota: false }])).toBeNull();
  });

  it("duas empresas da mesma pessoa contam como uma", () => {
    expect(nomeSugerido([
      { nome: "teste", dono: "ana", daNota: false },
      { nome: "Teste", dono: "ana", daNota: false },
    ])).toBeNull();
  });

  it("o mesmo nome digitado por 2 donos diferentes vira sugestão", () => {
    expect(nomeSugerido([
      { nome: "Whisky Gold Label",  dono: "ana", daNota: false },
      { nome: "whisky  gold label", dono: "bia", daNota: false },
      { nome: "lixo",               dono: "cris", daNota: false },
    ])).toEqual({ nome: "Whisky Gold Label", fonte: "empresas" });
  });

  it("nome de nota fiscal (descrição do fornecedor) vale com uma empresa e tem a grafia preferida", () => {
    expect(nomeSugerido([
      { nome: "carvao fumax",            dono: "ana", daNota: false },
      { nome: "CARVÃO FUMAX NARGUILE 1KG", dono: "bia", daNota: true },
    ])).toEqual({ nome: "CARVÃO FUMAX NARGUILE 1KG", fonte: "nota" });
  });

  it("com várias opções, ganha a que mais empresas usam", () => {
    expect(nomeSugerido([
      { nome: "WHISKY JW GOLD 750ML", dono: "ana",  daNota: true },
      { nome: "Gold Label 750ml",     dono: "bia",  daNota: false },
      { nome: "gold label 750ML",     dono: "cris", daNota: false },
    ])?.nome).toBe("Gold Label 750ml");
  });

  it("compara sem maiúscula, acento e espaço sobrando", () => {
    expect(normalizarNome("  Carvão   Fumax ")).toBe("carvao fumax");
  });
});

describe("itens lidos da SEFAZ que entram no catálogo (EQZ-60)", () => {
  it("só código de barras de verdade, nome limpo e sem repetir", () => {
    expect(linhasDoCatalogo([
      { codigo: "7891000100103", nome: "  LEITE  CONDENSADO 395G " },
      { codigo: "7891000100103", nome: "LEITE CONDENSADO 395G" },
      { codigo: "12345678-002",  nome: "CODIGO INTERNO DO FORNECEDOR" },
      { codigo: "7891000100104", nome: "DIGITO ERRADO" },
      { codigo: "7894900011517", nome: "   " },
    ], "35")).toEqual([{ codigo: "7891000100103", nome: "LEITE CONDENSADO 395G", uf: "35" }]);
  });
});
