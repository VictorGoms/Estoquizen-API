import { describe, it, expect } from "vitest";
import { prazoDaDesistencia, totalPago, DIAS_DESISTENCIA } from "../src/lib/desistencia.js";

/* O resend.ts cria o cliente do Resend ao ser importado e ele exige uma chave; nada é enviado aqui */
process.env.RESEND_API_KEY ??= "re_teste";
const { emailDesistencia } = await import("../src/lib/resend.js");

const DIA = 24 * 60 * 60;
const primeiro = Date.UTC(2026, 10, 2, 15) / 1000; // 02/11/2026 12h em Brasília, em segundos

describe("prazo da desistência (EQZ-50, CDC art. 49)", () => {
  it("conta 7 dias do 1º pagamento, mesmo com uma troca de plano depois", () => {
    const faturas = [
      { id: "in_troca", valor: 1500, pagaEm: primeiro + 3 * DIA },
      { id: "in_1",     valor: 2490, pagaEm: primeiro },
    ];
    expect(DIAS_DESISTENCIA).toBe(7);
    expect(prazoDaDesistencia(faturas)).toBe((primeiro + 7 * DIA) * 1000);
    expect(totalPago(faturas)).toBe(3990);
  });

  it("assinatura sem pagamento não tem o que devolver", () => {
    expect(prazoDaDesistencia([])).toBeNull();
    expect(totalPago([])).toBe(0);
  });
});

describe("e-mail Desistência confirmada (Decreto 7.962, art. 5º, § 4º)", () => {
  it("confirma o cancelamento, o valor no cartão e até quando os dados ficam", () => {
    const { subject, html } = emailDesistencia({ workspaceName: "Bar do Zé", devolvido: 2490, manual: 0 });
    expect(subject).toContain("Desistência confirmada");
    expect(html).toMatch(/Devolvemos <strong[^>]*>R\$\s24,90/);
    expect(html).toContain("não há mais cobranças");
    expect(html).toContain("ficam guardados até");
    expect(html).not.toContain("Pix ou transferência");
  });

  it("pagamento sem estorno automático (boleto) avisa que a devolução é combinada à mão", () => {
    const { html } = emailDesistencia({ workspaceName: "Bar do Zé", devolvido: 0, manual: 2490 });
    expect(html).toContain("Pix ou transferência");
    expect(html).not.toContain("no mesmo cartão");
  });

  it("escapa o nome do workspace", () => {
    const { html } = emailDesistencia({ workspaceName: "<b>Zé</b>", devolvido: 2490, manual: 0 });
    expect(html).not.toContain("<b>Zé</b>");
  });
});
