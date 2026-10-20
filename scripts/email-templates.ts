/*
 * Gera os modelos de e-mail do Supabase Auth no tema "Noite Azul", com o mesmo layout dos
 * e-mails da API. O Supabase não lê arquivos: cole cada HTML no painel (Authentication →
 * Emails → Templates), com o assunto indicado em supabase/templates/README.md.
 * Rodar: npx tsx scripts/email-templates.ts
 */
import { writeFileSync } from "node:fs";
import { layoutEmail, forte, codigo } from "../src/lib/emailLayout.js";

const modelos: Record<string, Parameters<typeof layoutEmail>[0]> = {
  "confirmar-cadastro": {
    preheader: "Falta só confirmar o e-mail para começar a usar o Estoquizen.",
    titulo:    "Confirme seu e-mail",
    corpo:     `Falta só um passo para começar a usar o Estoquizen. Toque no botão para confirmar o e-mail ${forte("{{ .Email }}")}.`,
    botao:     { texto: "Confirmar e-mail", url: "{{ .ConfirmationURL }}" },
    rodape:    "Se você não criou uma conta no Estoquizen, ignore este e-mail.",
  },
  "convite": {
    preheader: "Você foi convidado para um workspace no Estoquizen.",
    titulo:    "Você foi convidado",
    corpo:     `{{ if .Data.workspace_name }}Você foi convidado para o workspace ${forte("{{ .Data.workspace_name }}")} no Estoquizen.{{ else }}Você foi convidado para um workspace no Estoquizen.{{ end }}<br><br>Toque no botão para criar sua senha e entrar.`,
    botao:     { texto: "Aceitar convite", url: "{{ .ConfirmationURL }}" },
    rodape:    "Se você não esperava este convite, ignore este e-mail.",
  },
  "link-convite": {
    /* Modelo "Magic Link": o app só usa para convite de quem já tem conta */
    preheader: "Você tem um convite para um workspace no Estoquizen.",
    titulo:    "Você tem um convite",
    corpo:     "Você foi convidado para um workspace no Estoquizen. Toque no botão para entrar e ver o convite.",
    botao:     { texto: "Ver convite", url: "{{ .ConfirmationURL }}" },
    rodape:    "O link vale por pouco tempo e só pode ser usado uma vez. Se você não esperava este convite, ignore este e-mail.",
  },
  "recuperar-senha": {
    preheader: "Crie uma senha nova para entrar no Estoquizen.",
    titulo:    "Redefinir senha",
    corpo:     `Recebemos um pedido para redefinir a senha da conta ${forte("{{ .Email }}")}. Toque no botão para criar uma senha nova.`,
    botao:     { texto: "Criar senha nova", url: "{{ .ConfirmationURL }}" },
    rodape:    "Se você não pediu, ignore este e-mail: sua senha continua a mesma.",
  },
  "trocar-email": {
    preheader: "Confirme o novo e-mail da sua conta no Estoquizen.",
    titulo:    "Confirme o novo e-mail",
    corpo:     `Confirme a troca do e-mail da sua conta de ${forte("{{ .Email }}")} para ${forte("{{ .NewEmail }}")}.`,
    botao:     { texto: "Confirmar novo e-mail", url: "{{ .ConfirmationURL }}" },
    rodape:    "Se você não pediu essa troca, ignore este e-mail e troque sua senha.",
  },
  "reautenticacao": {
    /* Só sai se o app pedir reautenticação (supabase.auth.reauthenticate); hoje não pede */
    preheader: "Seu código para confirmar a alteração na conta do Estoquizen.",
    titulo:    "Confirme que é você",
    corpo:     `Use este código para confirmar a alteração na sua conta:${codigo("{{ .Token }}")}`,
    rodape:    "Se você não pediu nenhuma alteração, ignore este e-mail e troque sua senha.",
  },
};

for (const [nome, params] of Object.entries(modelos)) {
  writeFileSync(`supabase/templates/${nome}.html`, layoutEmail(params));
  console.log(`supabase/templates/${nome}.html`);
}
