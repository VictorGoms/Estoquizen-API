import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   ?? "smtp.gmail.com",
  port:   Number(process.env.SMTP_PORT ?? 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendWorkspaceInviteEmail(opts: {
  to:            string;
  toName:        string;
  workspaceName: string;
  inviterName:   string;
  acceptLink:    string;
}) {
  const { to, toName, workspaceName, inviterName, acceptLink } = opts;

  await transporter.sendMail({
    from:    `"Estoquizen" <${process.env.SMTP_USER}>`,
    to,
    subject: `Você foi convidado para o workspace "${workspaceName}"`,
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
        <tr><td style="color:#fff;font-size:20px;font-weight:700;text-align:center;padding-bottom:12px">
          Você foi convidado!
        </td></tr>
        <tr><td style="color:#94a3b8;font-size:14px;text-align:center;line-height:1.6;padding-bottom:32px">
          <strong style="color:#e2e8f0">${inviterName}</strong> convidou você para colaborar no workspace<br>
          <strong style="color:#60a5fa">${workspaceName}</strong>.
        </td></tr>
        <tr><td align="center" style="padding-bottom:32px">
          <a href="${acceptLink}"
             style="display:inline-block;background:linear-gradient(135deg,#2563EB,#1D4ED8);color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:10px">
            Aceitar convite →
          </a>
        </td></tr>
        <tr><td style="color:#475569;font-size:12px;text-align:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:24px">
          Se você não esperava este convite, pode ignorar este email.<br>
          O link expira em 24 horas.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
