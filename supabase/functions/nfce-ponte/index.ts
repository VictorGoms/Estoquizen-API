/*
 * Ponte no Brasil para a leitura de NFC-e (2026-10-23).
 *
 * Alguns portais da SEFAZ (ES, MA, RO, TO, PA, SE no diagnóstico de 2026-10-23) recusam conexões de fora
 * do Brasil, e a API roda nos EUA (Railway). A API chama esta função com o header `x-region: sa-east-1`
 * (data center de São Paulo) e ela faz UM pedido ao portal, sem seguir redirecionamento: os cookies, os
 * redirecionamentos e a leitura dos itens continuam na API (src/lib/nfce.ts).
 *
 * Segurança: verify_jwt desligado (as chaves novas não são JWT); só aceita uma secret key do projeto no
 * header `apikey` (a que a API usa como SUPABASE_SERVICE_ROLE_KEY) e só abre endereços .gov.br nas portas
 * padrão (mesma regra de ehPortalSefaz na API). Não grava nada.
 */
/* Bytes da página em base64: a API decodifica no charset que a página declara */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const PORTAS_OK = new Set(["", "80", "443", "444"]);
const ehPortalSefaz = (u: URL) =>
  (u.protocol === "http:" || u.protocol === "https:") && u.hostname.toLowerCase().endsWith(".gov.br")
  && !u.username && !u.password && PORTAS_OK.has(u.port);

function autorizado(apikey: string | null): boolean {
  if (!apikey) return false;
  try {
    const chaves = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")) as string[];
    return chaves.includes(apikey);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ erro: "use POST" }, { status: 405 });
  if (!autorizado(req.headers.get("apikey"))) return Response.json({ erro: "não autorizado" }, { status: 401 });

  let url: URL;
  let cookie = "";
  try {
    const corpo = await req.json();
    url    = new URL(String(corpo.url));
    cookie = typeof corpo.cookie === "string" ? corpo.cookie.slice(0, 4000) : "";
  } catch {
    return Response.json({ erro: "pedido inválido" }, { status: 400 });
  }
  if (!ehPortalSefaz(url)) return Response.json({ erro: "só portal .gov.br" }, { status: 400 });

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":      "Estoquizen/1.0 (+https://www.estoquizen.com.br)",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
      signal:   AbortSignal.timeout(12_000),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return Response.json({
      status:      res.status,
      location:    res.headers.get("location"),
      setCookie:   res.headers.getSetCookie(),
      contentType: res.headers.get("content-type"),
      corpo:       base64(bytes),
      regiao:      Deno.env.get("SB_REGION") ?? null,
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const causa = e.name === "TimeoutError" ? "tempo esgotado (12 s)" : (e.cause?.code ?? e.message);
    return Response.json({ erro: `conexão com ${url.hostname}: ${causa}`, regiao: Deno.env.get("SB_REGION") ?? null }, { status: 502 });
  }
});
