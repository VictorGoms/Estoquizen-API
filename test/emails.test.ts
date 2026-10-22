import { describe, it, expect } from "vitest";

/* O resend.ts cria o cliente do Resend ao ser importado e ele exige uma chave; nada é enviado aqui */
process.env.RESEND_API_KEY ??= "re_teste";
const { emailAssinaturaConfirmada } = await import("../src/lib/resend.js");

describe("e-mail Assinatura confirmada (EQZ-52, Decreto 7.962, art. 4º, III e IV)", () => {
  it("traz o prazo de 7 dias para desistir, o contato e o link dos Termos", () => {
    const { subject, html } = emailAssinaturaConfirmada({
      workspaceName: "Bar do Zé", planLabel: "Growth",
      pagoHoje: 3990, mensal: 3990, proximaCobranca: new Date("2026-11-21T12:00:00Z"),
    });
    expect(subject).toContain("Assinatura confirmada");
    expect(html).toContain("até 7 dias");
    expect(html).toContain("mailto:contato@estoquizen.com.br");
    expect(html).toMatch(/href="https?:\/\/[^"]+\/termos"/);
    expect(html).toMatch(/R\$\s39,90/);   // o pt-BR põe espaço não separável depois do R$
  });
});
