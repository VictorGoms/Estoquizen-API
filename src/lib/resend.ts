import { Resend } from "resend";
import { layoutEmail, escapeHtml, forte, link } from "./emailLayout.js";

const resend = new Resend(process.env.RESEND_API_KEY ?? "");

const FROM = "Estoquizen <noreply@estoquizen.com.br>";

/* O SDK do Resend não lança exceção quando o envio é recusado (ex.: domínio não verificado):
   devolve { error }. Lança aqui para quem chama poder registrar a falha. */
async function send(payload: Parameters<typeof resend.emails.send>[0]) {
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend recusou o envio: ${error.name} - ${error.message}`);
}

const siteUrl = () => (process.env.ALLOWED_ORIGINS ?? "https://www.estoquizen.com.br").split(",")[0].trim();
/* Contato com os clientes (o mesmo dos Termos e da Política); recebe pelo ImprovMX */
const CONTATO = "contato@estoquizen.com.br";

/* Data de exclusão por extenso curto ("19/11"), no horário de Brasília */
const diaMes = (d: Date) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

export async function sendExpirationWarningEmail(params: {
  to:           string;
  workspaceName: string;
  daysUntilDelete: number;
  /* O segundo e último aviso, 3 dias antes da exclusão */
  ultimoAviso?: boolean;
}) {
  const { to, workspaceName, daysUntilDelete, ultimoAviso = false } = params;
  const nome    = escapeHtml(workspaceName);
  const quando  = diaMes(new Date(Date.now() + daysUntilDelete * 24 * 60 * 60 * 1000));
  const faltam  = daysUntilDelete === 1 ? "Falta 1 dia" : `Faltam ${daysUntilDelete} dias`;

  await send({
    from:    FROM,
    to,
    subject: `${ultimoAviso ? "Último aviso: o" : "Seu"} workspace "${workspaceName}" será excluído em ${daysUntilDelete} dias`,
    html: layoutEmail({
      preheader: `${faltam} para os dados do ${workspaceName} serem excluídos. Assine de novo ou exporte antes.`,
      titulo:    ultimoAviso ? "Último aviso antes da exclusão" : "Seus dados vão ser excluídos",
      destaque:  { tom: ultimoAviso ? "zero" : "low", numero: String(daysUntilDelete), texto: `${faltam} para os dados serem excluídos (a partir de ${quando})` },
      corpo: `
        O workspace ${forte(nome)} está sem assinatura ativa. Quando o prazo acabar, os produtos,
        as movimentações e a equipe dele serão apagados de vez.<br><br>
        Para continuar, assine de novo. Para guardar uma cópia, exporte os dados em planilha:
        os dois botões ficam na tela do workspace.`,
      botao:  { texto: "Assinar de novo ou exportar", url: `${siteUrl()}/dashboard` },
      rodape: "Se você não quer continuar, pode ignorar este e-mail: os dados serão removidos no prazo acima.",
    }),
  });
}

const brl = (centavos: number) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

interface AssinaturaConfirmadaParams {
  workspaceName: string;
  planLabel:     string;
  /** Valor cobrado hoje, em centavos (já com crédito descontado) */
  pagoHoje:      number;
  /** Valor da mensalidade, em centavos */
  mensal:        number;
  proximaCobranca: Date | null;
}

/** Assinatura nova paga (checkout concluído): plano, valor de hoje e a próxima cobrança. */
export async function sendSubscriptionConfirmedEmail(params: AssinaturaConfirmadaParams & { to: string }) {
  await send({ from: FROM, to: params.to, ...emailAssinaturaConfirmada(params) });
}

/* Assunto e HTML, separados do envio para o teste conferir o texto exigido pelo Decreto 7.962
   (art. 4º, III e IV: confirmação com o contrato e a desistência em 7 dias) */
export function emailAssinaturaConfirmada({ workspaceName, planLabel, pagoHoje, mensal, proximaCobranca }: AssinaturaConfirmadaParams) {
  const nome = escapeHtml(workspaceName);
  const data = proximaCobranca?.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  return {
    subject: `Assinatura confirmada: plano ${planLabel} no workspace "${workspaceName}"`,
    html: layoutEmail({
      preheader: `Plano ${planLabel} ativo no ${workspaceName}. Obrigado por assinar o Estoquizen.`,
      titulo:    "Assinatura confirmada",
      destaque:  { tom: "ok", numero: "✓", texto: `Plano ${escapeHtml(planLabel)} ativo no workspace ${nome}` },
      corpo: `
        Recebemos o pagamento de ${forte(brl(pagoHoje))}${pagoHoje < mensal ? " (com o seu crédito descontado)" : ""}.
        ${data ? `A próxima cobrança é de ${forte(brl(mensal))} em ${forte(data)}, no mesmo cartão.` : `A mensalidade é de ${forte(brl(mensal))}.`}<br><br>
        Para trocar de plano, atualizar o cartão ou cancelar, vá em ${forte("Configurações → Plano atual")} no Estoquizen.<br><br>
        ${forte("Mudou de ideia?")} Você pode desistir em até 7 dias a partir deste pagamento e receber o valor de volta:
        escreva para ${link(CONTATO, `mailto:${CONTATO}`)}. Depois desse prazo, o cancelamento vale no fim do mês pago, sem reembolso
        proporcional. As regras completas estão nos ${link("Termos de Uso", `${siteUrl()}/termos`)}; guarde este e-mail como comprovante.`,
      botao:  { texto: "Abrir o Estoquizen", url: `${siteUrl()}/dashboard` },
      rodape: "Você recebeu este e-mail porque assinou o Estoquizen.",
    }),
  };
}

/** Troca de plano pelo portal (EQZ-07): de qual para qual, a mensalidade nova e o acerto do mês. */
export async function sendPlanChangedEmail(params: {
  to:            string;
  workspaceName: string;
  de:            string;
  para:          string;
  /** Mensalidade do plano novo, em reais */
  preco:         number;
  subiu:         boolean;
}) {
  const { to, workspaceName, de, para, preco, subiu } = params;
  const nome = escapeHtml(workspaceName);

  await send({
    from:    FROM,
    to,
    subject: `Plano alterado: o workspace "${workspaceName}" agora está no ${para}`,
    html: layoutEmail({
      preheader: `O ${workspaceName} mudou do ${de} para o ${para}. A mensalidade agora é ${preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`,
      titulo:    "Plano alterado",
      destaque:  { tom: "ok", numero: "✓", texto: `${escapeHtml(de)} → ${escapeHtml(para)} no workspace ${nome}` },
      corpo: `
        A mudança já vale. A mensalidade agora é de ${forte(preco.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }))}.<br><br>
        ${subiu
          ? "A diferença proporcional deste mês foi cobrada agora, no mesmo cartão."
          : "O valor não usado do plano anterior virou crédito e é descontado das próximas faturas."}
        Para ver as faturas ou trocar de novo, vá em ${forte("Configurações")} no Estoquizen.`,
      botao:  { texto: "Abrir Configurações", url: `${siteUrl()}/configuracoes` },
      rodape: "Você recebeu este e-mail porque o plano do seu workspace mudou.",
    }),
  });
}

/** Cancelamento agendado (EQZ-07): até quando vale, o que acontece depois e como desfazer. */
export async function sendCancelScheduledEmail(params: {
  to:            string;
  workspaceName: string;
  /** Fim do acesso completo (fim do ciclo pago) */
  acessoAte:     Date;
}) {
  const { to, workspaceName, acessoAte } = params;
  const nome      = escapeHtml(workspaceName);
  const guardados = new Date(acessoAte.getTime() + 30 * 24 * 60 * 60 * 1000);
  const dias      = Math.max(1, Math.ceil((acessoAte.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

  await send({
    from:    FROM,
    to,
    subject: `Cancelamento agendado: o workspace "${workspaceName}" fica ativo até ${diaMes(acessoAte)}`,
    html: layoutEmail({
      preheader: `O acesso completo continua até ${diaMes(acessoAte)}. Depois, os dados ficam guardados até ${diaMes(guardados)}.`,
      titulo:    "Cancelamento agendado",
      destaque:  { tom: "low", numero: String(dias), texto: `${dias === 1 ? "dia" : "dias"} de acesso completo no workspace ${nome} (até ${diaMes(acessoAte)})` },
      corpo: `
        A assinatura do ${forte(nome)} não será renovada e não há mais cobranças. Até ${forte(diaMes(acessoAte))}
        tudo continua funcionando.<br><br>
        Depois disso, o workspace fica bloqueado e os dados ficam guardados até ${forte(diaMes(guardados))},
        para você assinar de novo ou exportar uma planilha. Mudou de ideia? Em
        ${forte("Configurações")}, use ${forte("Desfazer cancelamento")} até ${diaMes(acessoAte)}.`,
      botao:  { texto: "Abrir Configurações", url: `${siteUrl()}/configuracoes` },
      rodape: `Obrigado por ter usado o Estoquizen. Se algo faltou, conte para a gente em ${CONTATO}.`,
    }),
  });
}

/* ── Pausa da assinatura (EQZ-07) ── */

/** Na hora de pausar: até quando usa, o período pausado, quando a cobrança volta e como desfazer. */
export async function sendPauseScheduledEmail(params: {
  to:            string;
  workspaceName: string;
  inicio:        Date;
  fim:           Date;
  meses:         number;
  /** Mensalidade que volta a ser cobrada, em reais */
  mensal:        number;
}) {
  const { to, workspaceName, inicio, fim, meses, mensal } = params;
  const nome  = escapeHtml(workspaceName);
  const valor = mensal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  await send({
    from:    FROM,
    to,
    subject: `Pausa agendada: o workspace "${workspaceName}" fica pausado de ${diaMes(inicio)} a ${diaMes(fim)}`,
    html: layoutEmail({
      preheader: `Você usa normalmente até ${diaMes(inicio)}. Nada é cobrado na pausa e os dados ficam guardados.`,
      titulo:    "Pausa agendada",
      destaque:  { tom: "ok", numero: String(meses), texto: `${meses === 1 ? "mês" : "meses"} de pausa no workspace ${nome}, sem cobrança (de ${diaMes(inicio)} a ${diaMes(fim)})` },
      corpo: `
        Até ${forte(diaMes(inicio))} tudo continua funcionando normalmente: esse período já está pago.<br><br>
        De ${forte(diaMes(inicio))} a ${forte(diaMes(fim))} o workspace fica pausado: o app não abre para a equipe,
        nada é cobrado e os dados ficam guardados. Em ${forte(diaMes(fim))} a mensalidade de ${forte(valor)} volta a ser
        cobrada no mesmo cartão e o acesso volta também.<br><br>
        Mudou de ideia? Em ${forte("Configurações")} dá para desfazer a pausa antes de ela começar, ou retomar antes durante a pausa.`,
      botao:  { texto: "Abrir Configurações", url: `${siteUrl()}/configuracoes` },
      rodape: "Você recebeu este e-mail porque pausou a assinatura do Estoquizen.",
    }),
  });
}

/** De 1 a 3 dias antes do fim da pausa: a cobrança e o acesso voltam nesse dia. */
export async function sendPauseEndingEmail(params: {
  to:            string;
  workspaceName: string;
  fim:           Date;
  mensal:        number;
}) {
  const { to, workspaceName, fim, mensal } = params;
  const nome  = escapeHtml(workspaceName);
  const valor = mensal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const dias  = Math.max(1, Math.ceil((fim.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

  await send({
    from:    FROM,
    to,
    subject: `Sua pausa acaba em ${diaMes(fim)}: o workspace "${workspaceName}" volta a funcionar`,
    html: layoutEmail({
      preheader: `Em ${diaMes(fim)} a mensalidade de ${valor} volta a ser cobrada no mesmo cartão e o acesso também.`,
      titulo:    "A pausa está acabando",
      destaque:  { tom: "low", numero: String(dias), texto: `${dias === 1 ? "dia" : "dias"} para o workspace ${nome} voltar (${diaMes(fim)})` },
      corpo: `
        Em ${forte(diaMes(fim))} a mensalidade de ${forte(valor)} é cobrada no mesmo cartão e o app volta a funcionar
        para toda a equipe, com os dados do jeito que ficaram.<br><br>
        Se não quiser continuar, cancele em ${forte("Configurações")} antes dessa data.`,
      botao:  { texto: "Abrir Configurações", url: `${siteUrl()}/configuracoes` },
      rodape: "Você recebeu este e-mail porque a assinatura do seu workspace está pausada.",
    }),
  });
}

/* ── E-mails da reta final do trial (EQZ-05), enviados pelo job diário ── */

const DIA_MS = 24 * 60 * 60 * 1000;
const diaBrasil = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const qtd = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;
const reais = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** "hoje", "amanhã" ou "em 24/10", pelo calendário de Brasília */
function quando(d: Date): string {
  const dia = diaBrasil(d);
  if (dia === diaBrasil(new Date())) return "hoje";
  if (dia === diaBrasil(new Date(Date.now() + DIA_MS))) return "amanhã";
  return `em ${diaMes(d)}`;
}

export interface ResumoWorkspace {
  produtos:      number;
  movimentacoes: number;
  /** Produtos zerados ou no mínimo agora */
  alertas:       number;
  /** Membros ativos, contando o dono */
  equipe:        number;
}

interface TrialEmailParams {
  to:            string;
  workspaceName: string;
  fimDoTeste:    Date;
  resumo:        ResumoWorkspace;
  planLabel:     string;
  /** Mensalidade do plano em teste, em reais */
  preco:         number;
}

const RODAPE_TRIAL = "Você recebeu este e-mail porque está testando o Estoquizen. Não há cobrança sem você assinar.";

/** ~4 dias antes do fim: o que a pessoa já fez (ou, com o workspace vazio, como começar). */
export async function sendTrialRecapEmail({ to, workspaceName, fimDoTeste, resumo, planLabel, preco }: TrialEmailParams) {
  const nome  = escapeHtml(workspaceName);
  const acaba = quando(fimDoTeste);
  const vazio = resumo.produtos === 0;

  const itens = [
    `${forte(qtd(resumo.movimentacoes, "movimentação registrada", "movimentações registradas"))} (entradas e saídas)`,
    resumo.alertas > 0
      ? `${forte(qtd(resumo.alertas, "produto em alerta", "produtos em alerta"))} agora, avisados antes de acabar`
      : "nenhum produto em alerta: o estoque está em dia",
    ...(resumo.equipe > 1 ? [`${forte(qtd(resumo.equipe, "pessoa", "pessoas"))} na equipe`] : []),
  ];

  await send({
    from:    FROM,
    to,
    subject: vazio ? `Seu teste do Estoquizen acaba ${acaba}: dá tempo de começar` : `Seu teste do Estoquizen até aqui (acaba ${acaba})`,
    html: layoutEmail({
      preheader: vazio
        ? `O ${workspaceName} ainda está vazio. Importe a sua planilha e veja o estoque em poucos minutos.`
        : `${qtd(resumo.produtos, "produto cadastrado", "produtos cadastrados")} e ${qtd(resumo.movimentacoes, "movimentação", "movimentações")} no ${workspaceName}. O teste acaba ${acaba}.`,
      titulo:   vazio ? "Ainda dá tempo de testar de verdade" : "O que você já fez no teste",
      destaque: vazio
        ? { tom: "low", numero: "0", texto: `produtos cadastrados no workspace ${nome} até agora` }
        : { tom: "ok", numero: resumo.produtos.toLocaleString("pt-BR"), texto: `${resumo.produtos === 1 ? "produto cadastrado" : "produtos cadastrados"} no workspace ${nome}` },
      corpo: vazio ? `
        O teste acaba ${forte(acaba)} e o ${forte(nome)} ainda não tem produtos. O jeito mais rápido de
        começar é trazer o que você já tem: importe a planilha que usa hoje (CSV ou Excel) ou leia a
        nota de compra do fornecedor.<br><br>
        Em poucos minutos o estoque está lá, com alerta de mínimo e a previsão de quando cada item acaba.` : `
        Até agora, o ${forte(nome)} tem:<br><br>
        ${itens.map((i) => `&bull;&nbsp; ${i}`).join("<br>")}<br><br>
        O teste acaba ${forte(acaba)}. Para continuar sem interrupção, assine o ${forte(escapeHtml(planLabel))}
        por ${forte(reais(preco))}/mês, ou escolha outro plano em Configurações.`,
      botao:  vazio
        ? { texto: "Importar minha planilha", url: `${siteUrl()}/estoque/importar` }
        : { texto: "Escolher meu plano", url: `${siteUrl()}/configuracoes` },
      rodape: RODAPE_TRIAL,
    }),
  });
}

/** Último dia do teste: o que acontece depois e como continuar. */
export async function sendTrialLastDayEmail({ to, workspaceName, fimDoTeste, resumo, planLabel, preco }: TrialEmailParams) {
  const nome   = escapeHtml(workspaceName);
  const acaba  = quando(fimDoTeste);
  const dias   = Math.max(1, Math.ceil((fimDoTeste.getTime() - Date.now()) / DIA_MS));
  const faltam = dias === 1 ? "Falta 1 dia" : `Faltam ${dias} dias`;

  await send({
    from:    FROM,
    to,
    subject: `Seu teste do Estoquizen acaba ${acaba}`,
    html: layoutEmail({
      preheader: `Assine para continuar usando o ${workspaceName} sem interrupção. Nada é apagado na hora.`,
      titulo:    `O teste acaba ${acaba}`,
      destaque:  { tom: "low", numero: String(dias), texto: `${faltam} de teste no workspace ${nome} (até ${diaMes(fimDoTeste)})` },
      corpo: `
        Depois disso, o ${forte(nome)} fica bloqueado até alguém assinar. Nada é apagado na hora:
        os dados ficam guardados por 30 dias.<br><br>
        ${resumo.produtos > 0 ? `Até aqui são ${forte(qtd(resumo.produtos, "produto", "produtos"))} e ${forte(qtd(resumo.movimentacoes, "movimentação", "movimentações"))}. ` : ""}Para continuar
        de onde parou, assine o ${forte(escapeHtml(planLabel))} por ${forte(reais(preco))}/mês. Também dá para
        escolher outro plano em Configurações.`,
      botao:  { texto: "Assinar agora", url: `${siteUrl()}/configuracoes` },
      rodape: RODAPE_TRIAL,
    }),
  });
}

/** Dia seguinte ao fim do teste: os dados estão guardados, até quando e como voltar. */
export async function sendTrialEndedEmail(params: {
  to:            string;
  workspaceName: string;
  fimDoTeste:    Date;
  /** Até quando os dados ficam guardados (fim do teste + 30 dias) */
  guardadoAte:   Date;
  resumo:        ResumoWorkspace;
}) {
  const { to, workspaceName, fimDoTeste, guardadoAte, resumo } = params;
  const nome = escapeHtml(workspaceName);
  const dias = Math.max(1, Math.ceil((guardadoAte.getTime() - Date.now()) / DIA_MS));

  await send({
    from:    FROM,
    to,
    subject: `Seu teste acabou, e os dados do "${workspaceName}" estão guardados`,
    html: layoutEmail({
      preheader: `Os dados ficam guardados até ${diaMes(guardadoAte)}. Assine quando quiser e tudo volta como estava.`,
      titulo:    "Seus dados estão guardados",
      destaque:  { tom: "ok", numero: String(dias), texto: `dias com os dados do workspace ${nome} guardados (até ${diaMes(guardadoAte)})` },
      corpo: `
        O teste do ${forte(nome)} acabou em ${forte(diaMes(fimDoTeste))} e o workspace está bloqueado.
        ${resumo.produtos > 0
          ? `Os ${forte(qtd(resumo.produtos, "produto", "produtos"))} e o histórico de ${forte(qtd(resumo.movimentacoes, "movimentação", "movimentações"))} continuam lá, do jeito que você deixou.`
          : "Nada foi apagado."}<br><br>
        Assine quando quiser e tudo volta na hora. Se preferir não continuar, exporte uma planilha com
        tudo na tela do workspace antes do prazo.`,
      botao:  { texto: "Assinar e voltar", url: `${siteUrl()}/dashboard` },
      rodape: "Antes de excluir qualquer coisa, mandamos mais dois avisos por e-mail.",
    }),
  });
}

export async function sendWorkspaceDeletionEmail(params: {
  to:           string;
  workspaceName: string;
}) {
  const { to, workspaceName } = params;

  await send({
    from:    FROM,
    to,
    subject: `Workspace "${workspaceName}" foi excluído`,
    html: layoutEmail({
      preheader: `O workspace ${workspaceName} foi excluído por falta de assinatura ativa.`,
      titulo:    "Workspace excluído",
      corpo: `
        O workspace ${forte(escapeHtml(workspaceName))} foi excluído por falta de assinatura ativa,
        depois dos avisos por e-mail.<br><br>
        Se quiser recomeçar, crie um workspace novo e escolha um plano.`,
      botao:  { texto: "Criar workspace", url: `${siteUrl()}/select-workspace` },
      rodape: "Obrigado por ter usado o Estoquizen.",
    }),
  });
}
