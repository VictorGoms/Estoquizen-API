# Modelos de e-mail do Supabase Auth

Tema "Noite Azul", com o mesmo layout dos e-mails da API (`src/lib/emailLayout.ts`).
O Supabase não lê estes arquivos: cada um é colado no painel, em
**Authentication → Emails → Templates**, no modelo indicado, junto com o assunto.

| Modelo no Supabase | Arquivo | Assunto | Quando sai |
|---|---|---|---|
| Confirm signup | `confirmar-cadastro.html` | Confirme seu e-mail no Estoquizen | Cadastro com e-mail e senha |
| Invite user | `convite.html` | Você foi convidado para o Estoquizen | Convite para quem ainda não tem conta (`inviteUserByEmail`) |
| Magic Link | `link-convite.html` | Seu convite no Estoquizen | Convite para quem já tem conta (`signInWithOtp` para `/aceitar-convite`) |
| Reset Password | `recuperar-senha.html` | Redefinir sua senha do Estoquizen | "Esqueci minha senha" |
| Change Email Address | `trocar-email.html` | Confirme seu novo e-mail no Estoquizen | Troca de e-mail da conta |

- Variáveis do Supabase usadas: `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` e
  `{{ .Data.workspace_name }}` (a API grava o nome do workspace no metadata do convite).
- Mudou o layout? Rode `npx tsx scripts/email-templates.ts` para gerar de novo e cole outra vez.
