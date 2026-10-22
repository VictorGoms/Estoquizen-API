import { describe, it, expect, vi, beforeEach } from "vitest";

/* Os e-mails saem pelo SDK do Resend: aqui ele é trocado por um que só guarda o que seria enviado */
const enviados: { subject: string; html: string }[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (p: { subject: string; html: string }) => { enviados.push(p); return { data: { id: "x" }, error: null }; } };
  },
}));

const { sendSubscriptionConfirmedEmail } = await import("../src/lib/resend.js");

describe("e-mail Assinatura confirmada (EQZ-52, Decreto 7.962, art. 4º, III e IV)", () => {
  beforeEach(() => { enviados.length = 0; });

  it("traz o prazo de 7 dias para desistir, o contato e o link dos Termos", async () => {
    await sendSubscriptionConfirmedEmail({
      to: "dono@exemplo.com", workspaceName: "Bar do Zé", planLabel: "Growth",
      pagoHoje: 3990, mensal: 3990, proximaCobranca: new Date("2026-11-21T12:00:00Z"),
    });
    const { html, subject } = enviados[0];
    expect(subject).toContain("Assinatura confirmada");
    expect(html).toContain("até 7 dias");
    expect(html).toContain("mailto:contato@estoquizen.com.br");
    expect(html).toMatch(/href="https:\/\/[^"]+\/termos"/);
    expect(html).toMatch(/R\$\s39,90/);   // o pt-BR põe espaço não separável depois do R$
  });
});
