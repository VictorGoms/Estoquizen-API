import { describe, it, expect } from "vitest";
import { sanitizeText, sanitizeCode, sanitizeCpf, sanitizeEmail } from "../src/lib/sanitize.js";
import { chaveValida, gtinValido, codigoDoItem, cnpjRaizDaChave } from "../src/lib/nfeChave.js";
import { getLimits, PLAN_LIMITS } from "../src/lib/plans.js";
import { escapeHtml, layoutEmail } from "../src/lib/emailLayout.js";
import { DIAS_TESTE, fimDoTeste } from "../src/lib/trial.js";

describe("sanitize", () => {
  it("texto: tira tags, null bytes e espaço sobrando, e corta no limite", () => {
    expect(sanitizeText("  <b>Arroz</b>\0   tipo 1  ")).toBe("Arroz tipo 1");
    expect(sanitizeText("abcdef", 3)).toBe("abc");
    expect(sanitizeText(42)).toBe("");
  });
  it("texto: tag aberta também sai (viraria link no e-mail de convite, run-2 da auditoria)", () => {
    expect(sanitizeText('Loja <a href="https://golpe.com" style=x')).toBe('Loja a href="https://golpe.com" style=x');
    expect(sanitizeText("Bar > Cia < Ltda")).toBe("Bar Cia Ltda");
  });
  it("código: só letras, números, hífen, ponto e sublinhado, em maiúsculas", () => {
    expect(sanitizeCode(" abc-12 3!@ ")).toBe("ABC-123");
  });
  it("e-mail em minúsculas", () => {
    expect(sanitizeEmail("  Joao@Exemplo.COM ")).toBe("joao@exemplo.com");
  });
  it("CPF: dígitos verificadores e sequência repetida", () => {
    expect(sanitizeCpf("529.982.247-25")).toBe("52998224725");
    expect(sanitizeCpf("529.982.247-26")).toBeNull();
    expect(sanitizeCpf("111.111.111-11")).toBeNull();
    expect(sanitizeCpf("123")).toBeNull();
    expect(sanitizeCpf(undefined)).toBeNull();
  });
});

describe("chave da NF-e e GTIN (SCRUM-59)", () => {
  const base = "3526101234567800019965001000012345100001234";
  it("exatamente um dígito verificador vale", () => {
    expect(Array.from({ length: 10 }, (_, d) => base + d).filter(chaveValida)).toHaveLength(1);
    expect(chaveValida(base)).toBe(false);
  });
  it("raiz do CNPJ e código do item", () => {
    expect(cnpjRaizDaChave(base + "0")).toBe("12345678");
    expect(gtinValido("4006381333931")).toBe(true);
    expect(codigoDoItem("4006381333931", "12345678")).toBe("4006381333931");
    expect(codigoDoItem("002", "12345678")).toBe("12345678-002");
    expect(codigoDoItem("SEM GTIN", "12345678")).toBe("");
  });
});

describe("planos (EQZ-27 e EQZ-11)", () => {
  it("limites e preços fechados", () => {
    expect(PLAN_LIMITS.basic).toMatchObject({ products: 50, members: 3, price: 24.9, notasPorMes: 2 });
    expect(PLAN_LIMITS.growth).toMatchObject({ products: 300, members: 10, price: 39.9, notasPorMes: null });
    expect(PLAN_LIMITS.pro).toMatchObject({ products: 2000, price: 59.9 });
  });
  it("plano desconhecido cai no Basic", () => {
    expect(getLimits("xyz")).toBe(PLAN_LIMITS.basic);
  });
});

describe("layout dos e-mails", () => {
  it("escapa o que vem do usuário", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
  });
  it("monta título, destaque, botão e rodapé", () => {
    const html = layoutEmail({
      preheader: "Pré", titulo: "Título do e-mail", corpo: "Corpo",
      destaque: { tom: "low", numero: "3", texto: "dias" },
      botao: { texto: "Abrir", url: "https://www.estoquizen.com.br/dashboard" },
      rodape: "Rodapé",
    });
    for (const t of ["Título do e-mail", "Corpo", "Abrir", "https://www.estoquizen.com.br/dashboard", "Rodapé", "#fbbf24"]) {
      expect(html).toContain(t);
    }
  });
  it("a prévia (preheader) leva o nome do workspace e sai escapada (run-2 da auditoria)", () => {
    const html = layoutEmail({ preheader: `O workspace Loja <a href="https://golpe.com" foi excluído`, titulo: "T", corpo: "C" });
    expect(html).not.toContain(`<a href="https://golpe.com"`);
    expect(html).toContain("Loja &lt;a href=&quot;https://golpe.com&quot;");
  });
});

describe("teste grátis (oferta de lançamento de 2026-10-21)", () => {
  it("dura 30 dias em todos os planos", () => {
    expect(DIAS_TESTE).toBe(30);
    const inicio = new Date("2026-10-21T12:00:00Z");
    expect(fimDoTeste(inicio).toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });
});
