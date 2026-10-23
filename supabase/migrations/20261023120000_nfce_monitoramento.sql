-- Monitoramento da leitura de NFC-e (2026-10-23, pedido do João antes de vender para outros estados).
--
-- nfce_falhas: cada consulta de cupom que falhou (estado, chave, link do QR quando veio, erro técnico).
--   Serve para corrigir o estado depois; o João recebe no máximo 1 e-mail por estado por dia (avisado).
--   Não guarda o HTML da página (pode ter o CPF do consumidor): com a chave ou o link dá para abrir de novo.
--   Apagadas depois de 90 dias pelo job diário.
-- nfce_diagnostico: teste semanal de cada UF feito pelo servidor com uma chave de teste válida
--   (o endereço responde? o servidor nos EUA entra? pede captcha?). Uma linha por UF, a última.
--
-- RLS ligada e sem policies: só a API (service_role) lê e grava, como cancel_feedback e trial_grants.

create table if not exists public.nfce_falhas (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  uf           text not null,
  chave        text not null check (chave ~ '^\d{44}$'),
  qr_url       text check (qr_url is null or length(qr_url) <= 1000),
  erro         text not null,
  detalhe      text,
  avisado      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists nfce_falhas_uf_criada on public.nfce_falhas (uf, created_at desc);
alter table public.nfce_falhas enable row level security;

create table if not exists public.nfce_diagnostico (
  uf            text primary key,
  url           text not null,
  resultado     text not null check (resultado in ('ok', 'captcha', 'erro')),
  detalhe       text,
  trecho        text,
  verificado_em timestamptz not null default now()
);
alter table public.nfce_diagnostico enable row level security;
