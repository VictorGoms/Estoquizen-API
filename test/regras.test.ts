import { describe, it, expect } from "vitest";
import { sanitizeText, sanitizeCode, sanitizeCpf, sanitizeEmail } from "../src/lib/sanitize.js";
import { chaveValida, gtinValido, codigoDoItem, cnpjRaizDaChave } from "../src/lib/nfeChave.js";
import { getLimits, PLAN_LIMITS } from "../src/lib/plans.js";
import { escapeHtml, layoutEmail } from "../src/lib/emailLayout.js";
import { DIAS_MINIMOS, fimDoTeste, normalizarEmail, hashEmailDoTeste } from "../src/lib/trial.js";

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

describe("teste grátis (lançamento grátis até 05/01/2027, decisão de 2026-10-28)", () => {
  it("quem começa antes vai até 05/01 inclusive (fim em 06/01 00:00 de Brasília)", () => {
    expect(fimDoTeste(new Date("2026-10-28T12:00:00Z")).toISOString()).toBe("2027-01-06T03:00:00.000Z");
    expect(fimDoTeste(new Date("2026-12-22T12:00:00Z")).toISOString()).toBe("2027-01-06T03:00:00.000Z");
  });
  it("quem começa perto da data ganha pelo menos 14 dias", () => {
    expect(DIAS_MINIMOS).toBe(14);
    expect(fimDoTeste(new Date("2027-01-03T12:00:00Z")).toISOString()).toBe("2027-01-17T12:00:00.000Z");
  });
  it("depois de 05/01, todo cadastro novo tem 14 dias", () => {
    expect(fimDoTeste(new Date("2027-02-01T12:00:00Z")).toISOString()).toBe("2027-02-15T12:00:00.000Z");
  });
});

/* Saída do Postgres de produção para o mesmo texto (conferida em 2026-10-28) */
const SHA_JOAO_GMAIL = "bc6729088c4a2271f55a0eb55136ffe6bb18d81c8859afbe3a9a65edd91ce352";

describe("1 teste por e-mail normalizado (2026-10-28)", () => {
  it("variações do mesmo Gmail viram o mesmo e-mail", () => {
    for (const e of ["joao@gmail.com", "Joao@Gmail.com", "j.o.a.o@gmail.com", "joao+teste2@gmail.com", " joao+x@googlemail.com "]) {
      expect(normalizarEmail(e), e).toBe("joao@gmail.com");
    }
  });
  it("fora do Gmail tira só o +algo (o ponto conta)", () => {
    expect(normalizarEmail("Ana.Lima+loja@Outlook.com")).toBe("ana.lima@outlook.com");
    expect(normalizarEmail("ana.lima@outlook.com")).not.toBe(normalizarEmail("analima@outlook.com"));
  });
  it("o hash é o mesmo para as variações e igual ao do SQL da migração", () => {
    expect(hashEmailDoTeste("j.oao+1@gmail.com")).toBe(hashEmailDoTeste("joao@gmail.com"));
    /* encode(sha256(convert_to('joao@gmail.com', 'UTF8')), 'hex') no Postgres */
    expect(hashEmailDoTeste("joao@gmail.com")).toBe(SHA_JOAO_GMAIL);
  });
});
