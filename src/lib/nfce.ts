import * as cheerio from "cheerio";
import { codigoDoItem, cnpjRaizDaChave } from "./nfeChave.js";

/** Erro da consulta com o status HTTP certo e a mensagem para a pessoa. `detalhe` é o técnico
    (por endereço tentado), para o log e para a tabela nfce_falhas */
export class NfceError extends Error {
  constructor(message: string, public status: number, public detalhe?: string) {
    super(message);
  }
}

export interface NfceItem {
  nome:           string;
  quantidade:     number;
  unidade:        string;  // normalized: "kg", "un", "L", "pc", etc.
  codigo:         string;  // EAN/GTIN from NF-e (may be empty)
  valor_unitario: number;  // always per-unit after normalization (e.g. g→kg multiplies by 1000)
  valor_total:    number;
}

/* ── Cache em memória — NFC-e é imutável, cache de 24h ── */
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h em ms
const cache = new Map<string, { itens: NfceItem[]; expiresAt: number }>();

function cacheGet(chave: string): NfceItem[] | null {
  const entry = cache.get(chave);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(chave); return null; }
  return entry.itens;
}

function cacheSet(chave: string, itens: NfceItem[]) {
  cache.set(chave, { itens, expiresAt: Date.now() + CACHE_TTL });
}

/* ── Endereço de consulta do QR Code de produção de cada UF ──
   Fonte: storage/wsnfe_4.00_mod65.xml do projeto aberto sped-nfe (nfephp-org, atualizado em 2025-07),
   porque o portal do ENCAT, que é a fonte oficial, estava fora do ar em 2026-10-23. A consulta só com a
   chave usa o formato da versão 3 do QR (p=chave|3|1, sem assinatura). O diagnóstico semanal
   (lib/nfceMonitor.ts) testa cada um a partir do servidor; mudou o endereço de um estado? Mude aqui */
const QR_PRODUCAO: Record<string, string> = {
  "11": "http://www.nfce.sefin.ro.gov.br/consultanfce/consulta.jsp",                // RO
  "12": "http://www.sefaznet.ac.gov.br/nfce/qrcode",                                 // AC
  "13": "https://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp",                // AM
  "14": "https://www.sefaz.rr.gov.br/servlet/qrcode",                                // RR
  "15": "https://appnfc.sefa.pa.gov.br/portal/view/consultas/nfce/nfceForm.seam",    // PA
  "16": "https://www.sefaz.ap.gov.br/nfce/nfcep.php",                                // AP
  "17": "http://www.sefaz.to.gov.br/nfce/qrcode",                                    // TO
  "21": "http://www.nfce.sefaz.ma.gov.br/portal/consultarNFCe.jsp",                  // MA
  "22": "http://www.sefaz.pi.gov.br/nfce/qrcode",                                    // PI
  "23": "http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html",                           // CE
  "24": "http://nfce.set.rn.gov.br/consultarNFCe.aspx",                              // RN
  "25": "http://www.sefaz.pb.gov.br/nfce",                                           // PB
  "26": "http://nfce.sefaz.pe.gov.br/nfce/consulta",                                 // PE
  "27": "http://nfce.sefaz.al.gov.br/QRCode/consultarNFCe.jsp",                      // AL
  "28": "http://www.nfce.se.gov.br/nfce/qrcode",                                     // SE
  /* BA por http: o https usa a raiz da ICP-Brasil, que o Node não reconhece ("fetch failed") */
  "29": "http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx",                      // BA
  "31": "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml",      // MG
  "32": "http://app.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx",                       // ES
  "33": "https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode",                 // RJ
  "35": "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx", // SP
  "41": "http://www.fazenda.pr.gov.br/nfce/qrcode",                                  // PR
  "42": "https://sat.sef.sc.gov.br/nfce/consulta",                                   // SC
  "43": "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",                            // RS
  "50": "http://www.dfe.ms.gov.br/nfce/qrcode",                                      // MS
  "51": "http://www.sefaz.mt.gov.br/nfce/consultanfce",                              // MT
  "52": "https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe",                // GO
  "53": "http://www.fazenda.df.gov.br/nfce/qrcode",                                  // DF
};

/** Endereços tentados (em paralelo) para a chave digitada, por UF */
export const PORTAIS: Record<string, (chave: string) => string[]> = Object.fromEntries(
  Object.entries(QR_PRODUCAO).map(([uf, base]) => [uf, (k: string) => [`${base}?p=${k}|3|1`]]),
);
/* SP também aceita a versão 2 e a página da chave (testados com cupom real) */
PORTAIS["35"] = (k) => [
  `${QR_PRODUCAO["35"]}?p=${k}|3|1`,
  `${QR_PRODUCAO["35"]}?p=${k}|2|1`,
  `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaChaveAcesso.aspx?chave=${k}`,
];

/* Código IBGE da UF (2 primeiros dígitos da chave) → sigla, para as mensagens */
export const ESTADO_NOME: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
  "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
  "41": "PR", "42": "SC", "43": "RS",
  "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

/* User-Agent honesto (2026-10-23): o firewall do portal de SP rejeita ("The requested URL was rejected")
   quem diz ser Chrome sem ser um navegador de verdade. Antes a API se apresentava como Chrome */
const FETCH_HEADERS = {
  "User-Agent":       "Estoquizen/1.0 (+https://www.estoquizen.com.br)",
  "Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":  "pt-BR,pt;q=0.9,en;q=0.5",
  "Accept-Encoding":  "gzip, deflate, br",
};

const toFloat = (str: string) =>
  parseFloat((str ?? "").replace(/[^\d,]/g, "").replace(",", ".")) || 0;

function parseQtyUnit(rqtdText: string, unitFallback = ""): { quantidade: number; unidade: string; priceFactor: number } {
  const cleaned = rqtdText.replace(/.*:\s*/, "").trim();
  const match   = cleaned.match(/^([\d.,]+)\s*(.*?)$/);
  let quantidade = parseFloat((match?.[1] ?? "0").replace(",", ".")) || 0;
  /* unit from same cell, or dedicated unit element (.RUN, .Rum, etc.) */
  const raw      = ((match?.[2] ?? "").trim() || unitFallback).toLowerCase();

  let unidade: string;
  let priceFactor = 1;

  switch (raw) {
    case "kg": case "kilo": case "quilograma": case "quilogramas":
      unidade = "kg"; break;
    case "g": case "gr": case "grama": case "gramas":
      unidade = "kg";
      quantidade = +(quantidade / 1000).toFixed(3);
      priceFactor = 1000; // price was per-gram → convert to per-kg
      break;
    case "l": case "lt": case "litro": case "litros":
      unidade = "L"; break;
    case "ml": case "mililitro": case "mililitros":
      unidade = "L";
      quantidade = +(quantidade / 1000).toFixed(3);
      priceFactor = 1000;
      break;
    case "pc": case "pcs": case "pç":
      unidade = "pc"; break;
    case "cx": case "caixa": case "caixas":
      unidade = "cx"; break;
    case "": case "un": case "und": case "unidade": case "unidades":
      unidade = "un"; break;
    default:
      unidade = raw.toUpperCase() || "un";
  }

  return { quantidade, unidade, priceFactor };
}

export function parseItens(html: string): NfceItem[] {
  const $ = cheerio.load(html);
  const itens: NfceItem[] = [];

  /* Seletor padrão da maioria dos portais estaduais */
  $("#tabResult tr").each((_, row) => {
    /* A SEFAZ alinha o nome com espaços ("NEUTRA          110V") */
    const nome = $(row).find(".txtTit").first().text().replace(/\s+/g, " ").trim();
    if (!nome) return;

    /* unit can live inside .Rqtd ("Qtd.: 2 KG") or in a separate .RUN/.Rum/.RunMed cell */
    const unitEl    = $(row).find(".RUN, .Rum, .RunMed, .Rund").first().text().replace(/.*:\s*/, "").trim();
    const { quantidade, unidade, priceFactor } = parseQtyUnit($(row).find(".Rqtd").text(), unitEl);
    const valor_unitario = toFloat($(row).find(".RvlUnit").text()) * priceFactor;
    const valor_total    = toFloat($(row).find(".valor").text());
    /* "(Código: 7891000100103 )": sem os parênteses, senão o EAN não é reconhecido e vira código do fornecedor */
    const codigo         = $(row).find(".RCod").text().replace(/[Cc]ód[^:]*:\s*/, "").replace(/[()\s]/g, "");

    itens.push({ nome, quantidade, unidade, codigo, valor_unitario, valor_total });
  });

  return itens;
}

/* Portal da SEFAZ: só endereços .gov.br, nas portas padrão (a API não vira proxy para outros sites).
   A 444 é a do portal de PE, que redireciona para lá */
const PORTAS_OK = new Set(["", "80", "443", "444"]);
const ehPortalSefaz = (u: URL) =>
  (u.protocol === "http:" || u.protocol === "https:") && u.hostname.toLowerCase().endsWith(".gov.br")
  && !u.username && !u.password && PORTAS_OK.has(u.port);

/**
 * Link lido do QR Code do cupom (2026-10-23). Ele traz a chave e uma assinatura, e abre a nota sem captcha
 * nos estados que pedem captcha na chave digitada (ex.: BA). Só vale link de portal da SEFAZ cuja chave
 * (`p=chave|...` na versão 2/3, `chNFe=` na antiga) seja a mesma da consulta.
 */
export function linkDoQrValido(qrUrl: string, chave: string): URL | null {
  let u: URL;
  try { u = new URL(qrUrl.trim()); } catch { return null; }
  if (!ehPortalSefaz(u)) return null;
  const doLink = (u.searchParams.get("p")?.split("|")[0] ?? u.searchParams.get("chNFe") ?? "").replace(/\D/g, "");
  return doLink === chave ? u : null;
}

/* Texto da página no charset que ela declara (cabeçalho ou <meta>): AM e RO usam ISO-8859-1, e o
   res.text() lia tudo como UTF-8 ("n�o encontrada", acentos dos produtos estragados) */
function decodificar(bytes: Uint8Array, contentType: string | null): string {
  const doCabecalho = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  const doMeta      = new TextDecoder("latin1").decode(bytes.slice(0, 4096)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(doCabecalho ?? doMeta ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);   // charset desconhecido
  }
}

/* Abre a página seguindo os redirecionamentos com os cookies: a Bahia guarda a nota na sessão e
   redireciona para a página do DANFE (sem o cookie, cai no captcha). Não sai de portais .gov.br */
async function buscarPagina(inicio: URL): Promise<{ html: string; url: URL }> {
  const cookies = new Map<string, string>();
  let url = inicio;
  for (let salto = 0; salto < 6; salto++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers:  { ...FETCH_HEADERS, ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}) },
        redirect: "manual",
        signal:   AbortSignal.timeout(12_000),
      });
    } catch (err) {
      /* "fetch failed" sozinho não diz nada: a causa (certificado, DNS, recusa, tempo) vai junto */
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const causa = e.name === "TimeoutError" ? "tempo esgotado (12 s)" : (e.cause?.code ?? e.cause?.message ?? e.message);
      throw new Error(`conexão com ${url.hostname}: ${causa}`);
    }
    for (const c of res.headers.getSetCookie()) {
      const par = c.split(";")[0];
      const i   = par.indexOf("=");
      if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get("location");
      await res.body?.cancel();
      if (!destino) throw new Error(`HTTP ${res.status} sem destino`);
      url = new URL(destino, url);
      if (!ehPortalSefaz(url)) throw new Error(`redirecionou para fora da SEFAZ (${url.hostname})`);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url.hostname}`);
    return { html: decodificar(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type")), url };
  }
  throw new Error("redirecionamentos demais");
}

/* Página de verificação de robô: pelo HTML ou pelo endereço para onde o portal mandou (AC, SC) */
const ehCaptcha = (html: string, url?: URL) => /captcha/i.test(html) || /captcha|securityverify/i.test(url?.pathname ?? "");

/** Itens da página do DANFE; "CAPTCHA" quando o portal pediu o código de verificação */
export function lerItensDaPagina(html: string, url?: URL): NfceItem[] {
  const itens = parseItens(html);
  if (itens.length > 0) return itens;
  if (ehCaptcha(html, url)) throw new Error("CAPTCHA");
  console.warn("[NFC-e] Nenhum item parseado. Trecho do HTML:\n" + html.slice(0, 800));
  throw new Error("HTML sem itens");
}

const fetchItens = async (url: URL) => { const p = await buscarPagina(url); return lerItensDaPagina(p.html, p.url); };

export interface Sondagem {
  /** ok = a página abriu sem captcha (com chave de teste, costuma ser "nota não encontrada") */
  resultado: "ok" | "captcha" | "erro";
  detalhe:   string;
  /** Começo do texto visível da página, para entender a resposta do portal */
  trecho:    string;
}

/** Diagnóstico (lib/nfceMonitor.ts): abre o endereço do estado e diz como o portal respondeu */
export async function sondarPortal(url: URL): Promise<Sondagem> {
  try {
    const { html, url: final } = await buscarPagina(url);
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    const trecho = $("body").text().replace(/\s+/g, " ").trim().slice(0, 300);
    const destino = `${final.hostname}${final.pathname}`;
    if (parseItens(html).length > 0) return { resultado: "ok", detalhe: `itens lidos em ${destino}`, trecho };
    if (ehCaptcha(html, final))      return { resultado: "captcha", detalhe: `captcha em ${destino}`, trecho };
    return { resultado: "ok", detalhe: `abriu ${destino}`, trecho };
  } catch (err) {
    return { resultado: "erro", detalhe: (err as Error).message, trecho: "" };
  }
}

export async function consultarNfce(chave: string, qrUrl?: string): Promise<NfceItem[]> {
  /* Cache hit — retorna instantâneo */
  const cached = cacheGet(chave);
  if (cached) return cached;

  const estadoCod = chave.slice(0, 2);
  const uf        = ESTADO_NOME[estadoCod];
  const buildUrls = PORTAIS[estadoCod];
  /* Link do QR: vale para qualquer estado, mesmo os que não estão em PORTAIS */
  const qr = qrUrl ? linkDoQrValido(qrUrl, chave) : null;

  if (!buildUrls && !qr) {
    throw new NfceError(
      uf ? `Ainda não lemos NFC-e de ${uf} pela chave digitada. Leia o QR Code do cupom ou use o XML da nota.`
         : "Essa chave não é de nenhum estado. Confira os 2 primeiros números.",
      422,
    );
  }

  const urls = [...(qr ? [qr] : []), ...(buildUrls ? buildUrls(chave).map((u) => new URL(u)) : [])];

  /* Dispara todas as URLs em paralelo — vence a primeira que responder */
  try {
    const lidos = await Promise.any(urls.map((url) => fetchItens(url)));
    /* Código interno do fornecedor ganha a raiz do CNPJ do emitente (está na chave) */
    const raiz  = cnpjRaizDaChave(chave);
    const itens = lidos.map((i) => ({ ...i, codigo: codigoDoItem(i.codigo, raiz) }));
    cacheSet(chave, itens);
    return itens;
  } catch (err) {
    /* AggregateError quando todas falharam. O detalhe técnico vai só para o log
       (antes a pessoa via "HTML sem itens | HTML sem itens | HTML sem itens") */
    const erros  = err instanceof AggregateError ? err.errors as Error[] : [err as Error];
    const detail = erros.map((e) => e?.message ?? String(e)).join(" | ");
    console.warn(`[NFC-e] consulta falhou (${chave.slice(0, 6)}…${qr ? ", com o link do QR" : ""}): ${detail}`);

    /* Estado que pede captcha na chave digitada (ex.: BA) e a pessoa não leu o QR */
    if (!qr && erros.some((e) => e?.message === "CAPTCHA")) {
      throw new NfceError(
        `${uf ? `Em ${uf}, a` : "A"} consulta pela chave digitada pede um código de verificação. Leia o QR Code do cupom ou use o XML da nota.`,
        422,
        detail,
      );
    }
    if (erros.every((e) => e?.message === "HTML sem itens" || e?.message === "CAPTCHA")) {
      throw new NfceError(
        "Não encontramos essa nota no portal da SEFAZ. Confira a chave; notas emitidas há poucos minutos podem demorar para aparecer.",
        404,
        detail,
      );
    }
    throw new NfceError(
      "O portal da SEFAZ não respondeu agora. Tente de novo em alguns minutos ou use o XML da nota.",
      502,
      detail,
    );
  }
}
