-- Run-2 da auditoria de segurança (2026-10-24): o nome do workspace vai para e-mails, inclusive o
-- convite do Supabase, que chega a OUTRA pessoa ({{ .Data.workspace_name }}). O sanitizeText da API só
-- tirava tag fechada: "Loja <a href=https://golpe" passava e viraria link num e-mail do nosso domínio.
-- E o dono/admin também troca o nome direto pelo Supabase (GRANT update(name)), por fora da API. A
-- trava fica no banco, para todos os caminhos. Em 2026-10-24 nenhum nome tinha < ou >.
alter table public.workspaces
  add constraint workspaces_nome_sem_tag
  check (name !~ '[<>]' and (description is null or description !~ '[<>]'));
