/*
 * Duplo envio (EQZ-67, checklist de segurança de 2026-10-28): o mesmo pedido mandado duas vezes (dois
 * toques no botão, rede que reenvia) não pode gravar duas entradas de estoque. O front manda o header
 * Idempotency-Key, que só muda depois de um envio que deu certo. A mesma chave em até JANELA_MS devolve
 * a resposta da primeira vez, inclusive se a primeira ainda está em andamento (os dois toques chegam
 * juntos). Resposta de erro não fica guardada: a pessoa corrige e tenta de novo com a mesma chave.
 * Em memória: a API roda numa instância só no Railway; reiniciar a API esquece as chaves.
 */
export const JANELA_MS = 2 * 60 * 1000;
const MAXIMO = 2000;

export interface Resposta {
  status: number;
  corpo:  unknown;
}

export function criarIdempotencia(agora: () => number = Date.now) {
  const vistas = new Map<string, { quando: number; resposta: Promise<Resposta> }>();

  return function umaVez(chave: string | undefined, executar: () => Promise<Resposta>): Promise<Resposta> {
    if (!chave) return executar();

    /* O Map guarda a ordem de entrada: as mais antigas vêm primeiro */
    const t = agora();
    for (const [k, v] of vistas) {
      if (t - v.quando <= JANELA_MS) break;
      vistas.delete(k);
    }

    const anterior = vistas.get(chave);
    if (anterior) return anterior.resposta;

    const resposta = executar();
    vistas.set(chave, { quando: t, resposta });
    if (vistas.size > MAXIMO) vistas.delete(vistas.keys().next().value as string);
    resposta.then(
      (r) => { if (r.status >= 300) vistas.delete(chave); },
      () => vistas.delete(chave),
    );
    return resposta;
  };
}

/** Chave do header, se for uma string curta; senão o pedido segue sem a trava */
export function chaveDoHeader(valor: string | string[] | undefined): string | undefined {
  return typeof valor === "string" && valor.length > 0 && valor.length <= 100 ? valor : undefined;
}
