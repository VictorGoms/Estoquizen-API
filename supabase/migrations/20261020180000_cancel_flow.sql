-- EQZ-07: cancelamento com 1 pergunta e uma oferta (pausar a cobrança 1 mês ou descer de plano).
-- cancel_feedback guarda o motivo e o que a pessoa fez; sobrevive à exclusão do workspace
-- (workspace_id vira null), porque serve para entender por que as pessoas saem.
-- RLS sem policies: só a API (service_role) lê e grava.
create table if not exists public.cancel_feedback (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  user_id      uuid not null,
  plan         text,
  motivo       text not null check (motivo in ('caro', 'pouco_uso', 'negocio_parado', 'faltou_recurso', 'outro_sistema', 'outro')),
  detalhe      text check (char_length(detalhe) <= 500),
  acao         text not null check (acao in ('cancelar', 'pausar', 'trocar_plano')),
  created_at   timestamptz not null default now()
);
alter table public.cancel_feedback enable row level security;

-- Pausa da cobrança (pause_collection do Stripe, faturas anuladas e acesso mantido):
-- paused_until = quando a cobrança volta; last_paused_at limita a 1 pausa por ano.
alter table public.subscriptions
  add column if not exists paused_until   timestamptz,
  add column if not exists last_paused_at timestamptz;
