/*
 * Layout dos e-mails no tema "Noite Azul" do app (cores do @theme do front): fundo ink, cartão
 * surface, botão accent em pílula, fonte Nunito com fallback. Tabelas e estilos inline, porque
 * e-mail não aceita CSS de verdade (Gmail ignora <style> em parte e não mostra SVG).
 * Usado nos e-mails da API (resend.ts) e para gerar os modelos do Supabase Auth
 * (scripts/email-templates.ts → supabase/templates/).
 */

const COR = {
  ink:      "#0b1220",
  surface:  "#151f33",
  surface2: "#1d2840",
  fg:       "#f4f7fc",
  muted:    "#a9b5c9",
  subtle:   "#8592a8",
  accent:   "#60a5fa",
};

/* Destaque no tom dos status do app: fundo e borda já misturados com o cartão (e-mail não
   garante rgba) */
const TOM = {
  low:  { texto: "#fbbf24", fundo: "#313231", borda: "#5a4f2f" },
  zero: { texto: "#fb7185", fundo: "#382b3f", borda: "#714054" },
};

const FONTE = "Nunito,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LOGO  = "https://www.estoquizen.com.br/logo.png";

/** Escapa texto do usuário (nome do workspace etc.) antes de ir para o HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface EmailParams {
  /** Texto que o leitor de e-mail mostra ao lado do assunto */
  preheader: string;
  titulo:    string;
  /** HTML já escapado (use escapeHtml no que vier do usuário) */
  corpo:     string;
  /** Quadro de destaque acima do título, como o da tela de bloqueio */
  destaque?: { tom: keyof typeof TOM; numero: string; texto: string };
  botao?:    { texto: string; url: string };
  rodape:    string;
}

export function layoutEmail({ preheader, titulo, corpo, destaque, botao, rodape }: EmailParams): string {
  const t = destaque ? TOM[destaque.tom] : null;

  const blocoDestaque = destaque && t ? `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:${t.fundo};border:1px solid ${t.borda};border-radius:20px">
                <tr>
                  <td width="72" align="center" style="padding:16px 0 16px 12px;color:${t.texto};font-size:34px;font-weight:900;line-height:1;font-family:${FONTE}">${destaque.numero}</td>
                  <td style="padding:16px 18px 16px 8px;color:${t.texto};font-size:15px;font-weight:900;line-height:1.4;font-family:${FONTE}">${destaque.texto}</td>
                </tr>
              </table>` : "";

  const blocoBotao = botao ? `
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0">
                <tr><td style="border-radius:999px;background:${COR.accent}">
                  <a href="${botao.url}" style="display:inline-block;padding:15px 30px;border-radius:999px;background:${COR.accent};color:${COR.ink};font-size:15px;font-weight:900;text-decoration:none;font-family:${FONTE}">${botao.texto}</a>
                </td></tr>
              </table>
              <p style="margin:20px 0 0;color:${COR.subtle};font-size:12px;line-height:1.6;font-weight:600;font-family:${FONTE}">
                Se o botão não abrir, copie este endereço no navegador:<br>
                <a href="${botao.url}" style="color:${COR.accent};word-break:break-all">${botao.url}</a>
              </p>` : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${titulo}</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@600;800;900&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${COR.ink}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COR.ink}">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COR.ink};padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
        <tr><td style="padding:0 8px 20px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td><img src="${LOGO}" width="36" height="36" alt="" style="display:block;border:0;border-radius:10px"></td>
            <td style="padding-left:10px;color:${COR.fg};font-size:19px;font-weight:900;font-family:${FONTE}">Estoquizen</td>
          </tr></table>
        </td></tr>
        <tr><td style="background:${COR.surface};border-radius:28px;padding:32px 28px">${blocoDestaque}
              <h1 style="margin:0 0 12px;color:${COR.fg};font-size:24px;font-weight:900;line-height:1.25;font-family:${FONTE}">${titulo}</h1>
              <div style="color:${COR.muted};font-size:15px;line-height:1.65;font-weight:600;font-family:${FONTE}">${corpo}</div>${blocoBotao}
        </td></tr>
        <tr><td style="padding:20px 16px 0;color:${COR.subtle};font-size:12px;line-height:1.6;font-weight:600;text-align:center;font-family:${FONTE}">
          ${rodape}<br>
          <span style="color:${COR.muted}">Estoquizen</span> · estoque simples para pequenos negócios
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Destaca um trecho dentro do corpo (mesmo peso dos números do app). */
export const forte = (s: string) => `<strong style="color:${COR.fg};font-weight:900">${s}</strong>`;
