/**
 * Catálogo próprio de códigos de barras (EQZ-53, 2026-10-23): quando o Open Food Facts e as bases
 * irmãs não conhecem um código, o nome vem do que os clientes do Estoquizen já cadastraram. Só o
 * código (GTIN de verdade) e o nome; nunca preço, quantidade, fornecedor ou a empresa.
 *
 * Regra contra nome de teste ou sem sentido (pedido do João): um nome só é sugerido a outra empresa se
 * - veio de uma nota fiscal importada: é a descrição do fornecedor, lida da SEFAZ ou do XML, e a tela
 *   da nota não deixa editar; ou
 * - foi digitado igual (sem diferença de maiúscula, acento e espaço) por 2 empresas de donos diferentes.
 * Um nome digitado por uma empresa só nunca aparece para as outras. Na tela é sempre uma sugestão.
 */

export interface FonteNome {
  nome:   string;
  /** Dono do workspace: duas empresas da mesma pessoa contam como uma */
  dono:   string;
  daNota: boolean;
}

export interface NomeSugerido {
  nome:  string;
  fonte: "nota" | "empresas";
}

/** Nome sem diferença de maiúscula, acento e espaços, para comparar. */
export const normalizarNome = (nome: string) =>
  nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function nomeSugerido(fontes: FonteNome[]): NomeSugerido | null {
  const grupos = new Map<string, { nome: string; donos: Set<string>; daNota: boolean }>();
  for (const f of fontes) {
    const chave = normalizarNome(f.nome);
    if (!chave) continue;
    const g = grupos.get(chave) ?? { nome: f.nome.replace(/\s+/g, " ").trim(), donos: new Set<string>(), daNota: false };
    g.donos.add(f.dono);
    /* A grafia da nota (do fornecedor) vale mais que a digitada */
    if (f.daNota && !g.daNota) g.nome = f.nome.replace(/\s+/g, " ").trim();
    g.daNota ||= f.daNota;
    grupos.set(chave, g);
  }

  const validos = [...grupos.values()].filter((g) => g.daNota || g.donos.size >= 2);
  if (!validos.length) return null;
  /* Mais empresas primeiro; empate, o que veio de nota */
  validos.sort((a, b) => b.donos.size - a.donos.size || Number(b.daNota) - Number(a.daNota));
  const melhor = validos[0];
  return { nome: melhor.nome, fonte: melhor.donos.size >= 2 ? "empresas" : "nota" };
}
