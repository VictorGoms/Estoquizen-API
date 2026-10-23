import { supabaseAdmin } from "./supabase.js";

/*
 * Fotos de produto ficam no Storage, em product-images/<workspace_id>/<arquivo> (sem subpastas). Ao
 * excluir um workspace, o banco apaga as tabelas em cascata, mas o Storage não: até 2026-10-23 as
 * fotos ficavam para trás, mesmo com os Termos e a Política prometendo a exclusão definitiva.
 * Agora a exclusão (job dos 30 dias e DELETE /workspaces/:id) apaga a pasta junto, e o job também
 * varre as pastas de workspaces que não existem mais (exclusões antigas ou uma falha no meio).
 */
const BUCKET = "product-images";
const LOTE   = 1000;
const UUID   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Apaga todas as fotos de um workspace e devolve quantas eram. Lança se o Storage recusar. */
export async function apagarFotosDoWorkspace(workspaceId: string): Promise<number> {
  if (!UUID.test(workspaceId)) throw new Error(`pasta inválida: ${workspaceId}`);
  let total = 0;
  /* Teto de lotes: se o Storage devolvesse sempre os mesmos arquivos, não fica em loop */
  for (let lote = 0; lote < 100; lote++) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(workspaceId, { limit: LOTE });
    if (error) throw new Error(`listar as fotos de ${workspaceId}: ${error.message}`);
    const arquivos = (data ?? []).filter((f) => f.id).map((f) => `${workspaceId}/${f.name}`);
    if (!arquivos.length) return total;
    const { error: erroRemover } = await supabaseAdmin.storage.from(BUCKET).remove(arquivos);
    if (erroRemover) throw new Error(`apagar as fotos de ${workspaceId}: ${erroRemover.message}`);
    total += arquivos.length;
    if (arquivos.length < LOTE) return total;
  }
  return total;
}

/** Das pastas do Storage, as que são de workspace (nome UUID) e não estão entre os que existem. */
export function pastasOrfas(pastas: string[], workspacesExistentes: Set<string>): string[] {
  return pastas.filter((p) => UUID.test(p) && !workspacesExistentes.has(p));
}

/** Apaga as fotos das pastas de workspaces que não existem mais. Lança se não der para ler o banco. */
export async function apagarFotosOrfas(): Promise<{ pastas: number; fotos: number }> {
  const pastas: string[] = [];
  for (let offset = 0; ; offset += LOTE) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: LOTE, offset });
    if (error) throw new Error(`listar as pastas de fotos: ${error.message}`);
    /* Pasta não tem id; arquivo solto na raiz tem */
    pastas.push(...(data ?? []).filter((f) => !f.id).map((f) => f.name));
    if ((data ?? []).length < LOTE) break;
  }

  /* Quais existem, de 100 em 100 (o endereço da consulta tem limite de tamanho). Qualquer erro
     para tudo: sem a lista certa, uma pasta de workspace vivo pareceria órfã */
  const existentes = new Set<string>();
  const candidatas = pastas.filter((p) => UUID.test(p));
  for (let i = 0; i < candidatas.length; i += 100) {
    const { data, error } = await supabaseAdmin.from("workspaces").select("id").in("id", candidatas.slice(i, i + 100));
    if (error || !data) throw new Error(`conferir os workspaces das fotos: ${error?.message ?? "sem resposta"}`);
    for (const w of data) existentes.add(w.id as string);
  }

  let fotos = 0;
  const orfas = pastasOrfas(pastas, existentes);
  for (const pasta of orfas) fotos += await apagarFotosDoWorkspace(pasta);
  return { pastas: orfas.length, fotos };
}
