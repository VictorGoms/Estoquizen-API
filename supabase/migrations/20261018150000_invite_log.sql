-- SCRUM-52: o limite diário de convites contava linhas de workspace_members criadas nas últimas
-- 24h. Convite revogado apaga a linha e reenvio não cria linha, então dava para mandar e-mails
-- sem limite (convidar, revogar, convidar). invite_log registra cada e-mail de convite enviado.
-- Não guarda o e-mail: só serve para a contagem. RLS sem policies: só a API acessa.
create table if not exists public.invite_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invited_by   uuid,
  created_at   timestamptz not null default now()
);

create index if not exists invite_log_workspace_created_idx on public.invite_log (workspace_id, created_at);

alter table public.invite_log enable row level security;
revoke all on public.invite_log from anon, authenticated;
