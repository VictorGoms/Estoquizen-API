-- EQZ-59 (auditoria de 2026-10-23): o Stripe pode mandar o mesmo evento mais de uma vez (reenvio). O
-- webhook grava o id do evento antes de processar; se já existe, responde 200 sem refazer nada (nem
-- os e-mails). Se o processamento falha, a API apaga a linha para o reenvio processar de novo.
-- Só a API (service role) acessa.
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;
