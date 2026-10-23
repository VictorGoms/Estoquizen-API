import { describe, it, expect } from "vitest";
import { parseItens, lerItensDaPagina, linkDoQrValido, PORTAIS, ESTADO_NOME } from "../src/lib/nfce.js";
import { chaveDeTeste, chaveValida } from "../src/lib/nfeChave.js";

/* Tabela de itens da página do DANFE da SEFAZ-BA (cupom real de 2026-09, só a parte dos produtos).
   É o mesmo modelo de SP */
const TABELA_BA = `
<table border="0" align="center" cellpadding="0" cellspacing="0" id="tabResult" data-filter="true">
  <tr id="Item + 1">
    <td valign="top">
      <span class="txtTit">B &amp; D FERRO VFA-1110 NEUTRA          110V</span>
      <span class="RCod">(Código: 112475)</span><br>
      <span class="Rqtd"><strong>Qtde.:</strong>1</span>
      <span class="RUN"><strong>UN: </strong>PC</span>
      <span class="RvlUnit"><strong>Vl. Unit.:</strong> 177,91</span>
    </td>
    <td align="right" valign="top" class="txtTit noWrap">Vl. Total<br><span class="valor">177,91</span></td>
  </tr>
</table>`;

const CHAVE = "29260926404731038835650030000106581333900715";

describe("leitura da NFC-e (BA, 2026-10-23)", () => {
  it("lê o item da página do DANFE da Bahia", () => {
    const [item] = parseItens(TABELA_BA);
    expect(item.nome).toBe("B & D FERRO VFA-1110 NEUTRA 110V");
    expect(item.quantidade).toBe(1);
    expect(item.unidade).toBe("pc");
    expect(item.valor_unitario).toBe(177.91);
    expect(item.valor_total).toBe(177.91);
    expect(item.codigo).toBe("112475");
  });

  it("código de barras sai sem os parênteses (antes o EAN virava código do fornecedor)", () => {
    const comEan = TABELA_BA.replace("(Código: 112475)", "(Código: 7891000100103 )");
    expect(parseItens(comEan)[0].codigo).toBe("7891000100103");
  });

  it("página com captcha (chave digitada na Bahia) avisa CAPTCHA, não 'sem itens'", () => {
    const captcha = `<html><img id="img_captcha" src="captcha.aspx"><input name="txt_cod_antirobo"></html>`;
    expect(() => lerItensDaPagina(captcha)).toThrow("CAPTCHA");
    expect(() => lerItensDaPagina("<html>nada</html>")).toThrow("HTML sem itens");
  });
});

describe("link do QR Code do cupom", () => {
  const QR = `http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx?p=${CHAVE}|2|1|1|1f8501ab3de60bfe74106790c635ecd5b48ff6d2`;

  it("aceita o link da SEFAZ com a mesma chave (versão 2 e a antiga chNFe)", () => {
    expect(linkDoQrValido(QR, CHAVE)?.hostname).toBe("nfe.sefaz.ba.gov.br");
    expect(linkDoQrValido(`https://www.sefaz.mt.gov.br/nfce/consultanfce?chNFe=${CHAVE}&nVersao=100`, CHAVE)).not.toBeNull();
  });

  it("recusa link de fora da SEFAZ, com outra chave ou porta estranha", () => {
    expect(linkDoQrValido(QR.replace("nfe.sefaz.ba.gov.br", "sefaz.ba.gov.br.golpe.com"), CHAVE)).toBeNull();
    expect(linkDoQrValido(QR.replace("http://", "file://"), CHAVE)).toBeNull();
    expect(linkDoQrValido(QR.replace("nfe.sefaz.ba.gov.br", "nfe.sefaz.ba.gov.br:8080"), CHAVE)).toBeNull();
    expect(linkDoQrValido(QR.replace("http://", "http://usuario:senha@"), CHAVE)).toBeNull();
    expect(linkDoQrValido(QR, CHAVE.replace(/5$/, "6"))).toBeNull();
    expect(linkDoQrValido("não é link", CHAVE)).toBeNull();
  });
});

describe("diagnóstico dos 27 estados", () => {
  it("todos os estados têm endereço de portal .gov.br e sigla", () => {
    const cods = Object.keys(PORTAIS);
    expect(cods).toHaveLength(27);
    for (const cod of cods) {
      expect(ESTADO_NOME[cod], cod).toBeTruthy();
      for (const url of PORTAIS[cod](chaveDeTeste(cod))) expect(new URL(url).hostname, url).toMatch(/\.gov\.br$/);
    }
  });

  it("a chave de teste é válida, do estado e de NFC-e (modelo 65)", () => {
    for (const cod of Object.keys(PORTAIS)) {
      const k = chaveDeTeste(cod, new Date("2026-10-23T12:00:00Z"));
      expect(chaveValida(k), cod).toBe(true);
      expect(k.slice(0, 2)).toBe(cod);
      expect(k.slice(2, 6)).toBe("2610");
      expect(k.slice(20, 22)).toBe("65");
    }
  });
});
