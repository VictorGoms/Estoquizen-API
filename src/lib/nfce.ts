import * as cheerio from "cheerio";

export interface NfceItem {
  nome:           string;
  quantidade:     number;
  valor_unitario: number;
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

/* ── URLs por estado — versão 3 (padrão NFC-e atual) ── */
const PORTAIS: Record<string, (chave: string) => string[]> = {
  "35": (k) => [
    /* SP — tenta QRCode v3 depois v2, depois chave direta */
    `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${k}|3|1`,
    `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${k}|2|1`,
    `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaChaveAcesso.aspx?chave=${k}`,
  ],
  "41": (k) => [`https://www.nfce.sefa.pr.gov.br/nfce/qrcode?p=${k}|3|1`],
  "33": (k) => [`http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${k}|3|1`],
  "43": (k) => [`https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${k}|3|1`],
  "31": (k) => [`https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${k}|3|1`],
  "29": (k) => [`https://nfe.sefaz.ba.gov.br/servicos/nfce/default.aspx?p=${k}|3|1`],
  "23": (k) => [`http://nfce.sefaz.ce.gov.br/pages/showNFCe.html?p=${k}|3|1`],
  "32": (k) => [`https://app.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx?p=${k}|3|1`],
  "50": (k) => [`http://www.dfe.ms.gov.br/nfce/qrcode?p=${k}|3|1`],
  "51": (k) => [`https://www.sefaz.mt.gov.br/nfce/consultanfce?p=${k}|3|1`],
};

const ESTADO_NOME: Record<string, string> = {
  "35": "SP", "41": "PR", "33": "RJ", "43": "RS", "31": "MG",
  "29": "BA", "23": "CE", "32": "ES", "50": "MS", "51": "MT",
};

const FETCH_HEADERS = {
  "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":  "pt-BR,pt;q=0.9,en;q=0.5",
  "Accept-Encoding":  "gzip, deflate, br",
};

const toFloat = (str: string) =>
  parseFloat((str ?? "").replace(/[^\d,]/g, "").replace(",", ".")) || 0;

function parseItens(html: string): NfceItem[] {
  const $ = cheerio.load(html);
  const itens: NfceItem[] = [];

  /* Seletor padrão da maioria dos portais estaduais */
  $("#tabResult tr").each((_, row) => {
    const nome = $(row).find(".txtTit").first().text().trim();
    if (!nome) return;

    const quantidade     = parseFloat($(row).find(".Rqtd").text().replace(/.*:\s*/, "").trim()) || 0;
    const valor_unitario = toFloat($(row).find(".RvlUnit").text());
    const valor_total    = toFloat($(row).find(".valor").text());

    itens.push({ nome, quantidade, valor_unitario, valor_total });
  });

  return itens;
}

async function fetchItens(url: string): Promise<NfceItem[]> {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: "follow",
    signal:   AbortSignal.timeout(5_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html  = await res.text();
  const itens = parseItens(html);

  if (itens.length === 0) {
    console.warn("[NFC-e] Nenhum item parseado. Trecho do HTML:\n" + html.slice(0, 800));
    throw new Error("HTML sem itens");
  }

  return itens;
}

export async function consultarNfce(chave: string): Promise<NfceItem[]> {
  /* Cache hit — retorna instantâneo */
  const cached = cacheGet(chave);
  if (cached) return cached;

  const estadoCod = chave.slice(0, 2);
  const buildUrls = PORTAIS[estadoCod];

  if (!buildUrls) {
    const uf = ESTADO_NOME[estadoCod] ?? `código ${estadoCod}`;
    throw new Error(`Estado ${uf} ainda não suportado na consulta manual. Use a opção de QR Code.`);
  }

  const urls = buildUrls(chave);

  /* Dispara todas as URLs em paralelo — vence a primeira que responder */
  try {
    const itens = await Promise.any(urls.map((url) => fetchItens(url)));
    cacheSet(chave, itens);
    return itens;
  } catch (err) {
    /* AggregateError quando todas falharam */
    const detail = err instanceof AggregateError
      ? err.errors.map((e: Error) => e.message).join(" | ")
      : err instanceof Error ? err.message : String(err);

    throw new Error(
      `Não foi possível consultar a NFC-e. ${detail}. ` +
      `Verifique se a chave está correta e se o portal SEFAZ está disponível.`
    );
  }
}
