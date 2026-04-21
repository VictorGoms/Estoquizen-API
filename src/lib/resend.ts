import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY ?? "");

const FROM = "Estoquizen <noreply@estoquizen.com.br>";

export async function sendExpirationWarningEmail(params: {
  to:           string;
  workspaceName: string;
  daysUntilDelete: number;
}) {
  const { to, workspaceName, daysUntilDelete } = params;
  const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();

  await resend.emails.send({
    from:    FROM,
    to,
    subject: `Seu workspace "${workspaceName}" será excluído em ${daysUntilDelete} dias`,
    html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:rgba(15,23,42,0.9);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:40px">
        <tr><td align="center" style="padding-bottom:32px">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="background:linear-gradient(135deg,#2563EB,#1D4ED8);border-radius:10px;width:36px;height:36px;text-align:center;vertical-align:middle">
              <span style="color:#fff;font-size:18px">📦</span>
            </td>
            <td style="padding-left:10px;color:#fff;font-size:18px;font-weight:700">Estoquizen</td>
          </tr></table>
        </td></tr>
        <tr><td style="color:#F59E0B;font-size:20px;font-weight:700;text-align:center;padding-bottom:12px">
          ⚠️ Aviso de exclusão
        </td></tr>
        <tr><td style="color:#94a3b8;font-size:14px;text-align:center;line-height:1.7;padding-bottom:32px">
          O workspace <strong style="color:#e2e8f0">${workspaceName}</strong> será excluído em<br>
          <strong style="color:#F59E0B;font-size:18px">${daysUntilDelete} dias</strong><br>
          por falta de assinatura ativa.<br><br>
          Todos os seus produtos, movimentações e membros serão perdidos permanentemente.
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px">
          <a href="${siteUrl}/dashboard"
             style="display:inline-block;background:linear-gradient(135deg,#2563EB,#1D4ED8);color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:10px">
            Reativar assinatura →
          </a>
        </td></tr>
        <tr><td style="color:#475569;font-size:12px;text-align:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:24px">
          Se você não deseja continuar, pode ignorar este email.<br>
          Seus dados serão removidos após o prazo acima.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

export async function sendWorkspaceDeletionEmail(params: {
  to:           string;
  workspaceName: string;
}) {
  const { to, workspaceName } = params;

  await resend.emails.send({
    from:    FROM,
    to,
    subject: `Workspace "${workspaceName}" foi excluído`,
    html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:rgba(15,23,42,0.9);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:40px">
        <tr><td align="center" style="padding-bottom:32px">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="background:linear-gradient(135deg,#2563EB,#1D4ED8);border-radius:10px;width:36px;height:36px;text-align:center;vertical-align:middle">
              <span style="color:#fff;font-size:18px">📦</span>
            </td>
            <td style="padding-left:10px;color:#fff;font-size:18px;font-weight:700">Estoquizen</td>
          </tr></table>
        </td></tr>
        <tr><td style="color:#EF4444;font-size:20px;font-weight:700;text-align:center;padding-bottom:12px">
          Workspace excluído
        </td></tr>
        <tr><td style="color:#94a3b8;font-size:14px;text-align:center;line-height:1.7;padding-bottom:32px">
          O workspace <strong style="color:#e2e8f0">${workspaceName}</strong> foi excluído<br>
          por falta de assinatura ativa.<br><br>
          Se isso foi um engano ou se deseja recomeçar, crie um novo workspace com um novo plano.
        </td></tr>
        <tr><td style="color:#475569;font-size:12px;text-align:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:24px">
          Obrigado por ter usado o Estoquizen.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
