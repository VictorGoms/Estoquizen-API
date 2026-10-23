import type { FastifyBaseLogger } from "fastify";
import { supabaseAdmin } from "./supabase.js";
import { PORTAIS, ESTADO_NOME, linkDoQrValido, sondarPortal } from "./nfce.js";
import { chaveDeTeste } from "./nfeChave.js";
import { sendNfceFalhaEmail, sendNfceDiagnosticoEmail } from "./resend.js";

/*
 * Monitoramento da leitura de NFC-e (2026-10-23). O João quer vender para todo o Brasil sem ter cupom de
 * cada estado, então:
 * - diagnóstico semanal: o servidor (nos EUA, que é de onde as consultas saem de verdade) testa o portal
 *   de cada UF com uma chave de teste válida e grava em nfce_diagnostico. Estado que passou a dar erro
 *   gera e-mail para o contato@;
 * - cada leitura que falha para um cliente vai para nfce_falhas, com e-mail para o contato@ no máximo
 *   1 vez por estado a cada 24 h. As falhas somem depois de 90 dias.
 */

const DIA = 24 * 60 * 60 * 1000;
const INTERVALO_DIAGNOSTICO = 7 * DIA;
const GUARDA_FALHAS = 90 * DIA;


/** Roda o diagnóstico se o último tem 7 dias ou mais (ou `forcar`). Sem pressa: um estado por vez. */
export async function diagnosticoNfce(log: FastifyBaseLogger, forcar = false) {
  const { data: ultimo } = await supabaseAdmin
    .from("nfce_diagnostico").select("verificado_em").order("verificado_em", { ascending: false }).limit(1).maybeSingle();
  if (!forcar && ultimo && Date.now() - new Date(ultimo.verificado_em).getTime() < INTERVALO_DIAGNOSTICO) {
    return { rodou: false as const };
  }

  const { data: anteriores } = await supabaseAdmin.from("nfce_diagnostico").select("uf, resultado");
  const antes = new Map((anteriores ?? []).map((r) => [r.uf, r.resultado]));

  const linhas = [];
  for (const [cod, montar] of Object.entries(PORTAIS)) {
    const url = new URL(montar(chaveDeTeste(cod))[0]);
    const r   = await sondarPortal(url);
    linhas.push({
      uf:            ESTADO_NOME[cod] ?? cod,
      url:           `${url.origin}${url.pathname}`,
      resultado:     r.resultado,
      detalhe:       r.detalhe.slice(0, 500),
      trecho:        r.trecho.slice(0, 300),
      verificado_em: new Date().toISOString(),
    });
  }

  const { error } = await supabaseAdmin.from("nfce_diagnostico").upsert(linhas, { onConflict: "uf" });
  if (error) log.error({ err: error }, "[NFC-e] falha ao gravar o diagnóstico");

  /* Avisa só o que quebrou desde a última vez (na primeira rodada, todos os que deram erro) */
  const quebrados = linhas.filter((l) => l.resultado === "erro" && antes.get(l.uf) !== "erro");
  const resumo = {
    ok:      linhas.filter((l) => l.resultado === "ok").length,
    captcha: linhas.filter((l) => l.resultado === "captcha").length,
    erro:    linhas.filter((l) => l.resultado === "erro").length,
  };
  if (quebrados.length) {
    await sendNfceDiagnosticoEmail({ quebrados, ok: resumo.ok, captcha: resumo.captcha })
      .catch((err) => log.error({ err }, "[NFC-e] falha ao mandar o e-mail do diagnóstico"));
  }

  /* Faxina: falhas antigas não servem mais para corrigir nada */
  await supabaseAdmin.from("nfce_falhas").delete().lt("created_at", new Date(Date.now() - GUARDA_FALHAS).toISOString());

  log.info({ ...resumo, quebrados: quebrados.map((q) => q.uf) }, "[NFC-e] diagnóstico concluído");
  return { rodou: true as const, ...resumo, quebrados: quebrados.map((q) => q.uf) };
}

/** Uma leitura de cupom falhou para um cliente: grava e, se for a 1ª do estado em 24 h, avisa por e-mail. */
export async function registrarFalhaNfce(
  p: { workspaceId: string; chave: string; qrUrl?: string; erro: string; detalhe?: string },
  log: FastifyBaseLogger,
) {
  try {
    const uf    = ESTADO_NOME[p.chave.slice(0, 2)] ?? p.chave.slice(0, 2);
    const qrUrl = p.qrUrl && linkDoQrValido(p.qrUrl, p.chave) ? p.qrUrl.trim().slice(0, 1000) : null;

    const { data: recente } = await supabaseAdmin
      .from("nfce_falhas").select("id").eq("uf", uf).eq("avisado", true)
      .gte("created_at", new Date(Date.now() - DIA).toISOString()).limit(1);
    const avisar = !recente?.length;

    const { error } = await supabaseAdmin.from("nfce_falhas").insert({
      workspace_id: p.workspaceId, uf, chave: p.chave, qr_url: qrUrl,
      erro: p.erro.slice(0, 300), detalhe: p.detalhe?.slice(0, 1000) ?? null, avisado: avisar,
    });
    if (error) { log.error({ err: error }, "[NFC-e] falha ao gravar em nfce_falhas"); return; }

    if (avisar) await sendNfceFalhaEmail({ uf, erro: p.erro, detalhe: p.detalhe ?? null, chave: p.chave, qrUrl });
  } catch (err) {
    log.error({ err }, "[NFC-e] falha ao registrar a falha da leitura");
  }
}
