import { Resend } from "resend";
import { layoutEmail, escapeHtml, forte } from "./emailLayout.js";

const resend = new Resend(process.env.RESEND_API_KEY ?? "");

const FROM = "Estoquizen <noreply@estoquizen.com.br>";

/* O SDK do Resend não lança exceção quando o envio é recusado (ex.: domínio não verificado):
   devolve { error }. Lança aqui para quem chama poder registrar a falha. */
async function send(payload: Parameters<typeof resend.emails.send>[0]) {
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend recusou o envio: ${error.name} - ${error.message}`);
}

const siteUrl = () => (process.env.ALLOWED_ORIGINS ?? "https://www.estoquizen.com.br").split(",")[0].trim();

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
