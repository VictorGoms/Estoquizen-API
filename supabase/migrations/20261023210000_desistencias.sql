-- EQZ-50, decisão do João (2026-10-23): a desistência com o valor de volta pelo app vale 1 vez por
-- pessoa, contada pelo usuário e pelo CPF codificado (o mesmo SHA-256 do trial_grants). Da 2ª em diante,
-- o botão não aparece e o pedido vai pelo contato@, para decidir caso a caso: assinar e desistir em
-- sequência custaria a tarifa do Stripe a cada vez, que não volta no reembolso.
-- Sem chave estrangeira: o registro fica mesmo depois da exclusão do workspace ou da conta, só para
-- esta regra (a Política, seção 5, avisa). Só a API acessa.
create table if not exists public.desistencias (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null,
  cpf_hash               text,
  workspace_id           uuid,
  stripe_subscription_id text,
  devolvido              integer not null default 0,   -- centavos, estorno no cartão
  manual                 integer not null default 0,   -- centavos, devolvido à mão (boleto)
  created_at             timestamptz not null default now()
);

create index if not exists desistencias_user_id_idx  on public.desistencias (user_id);
create index if not exists desistencias_cpf_hash_idx on public.desistencias (cpf_hash) where cpf_hash is not null;

alter table public.desistencias enable row level security;
revoke all on public.desistencias from anon, authenticated;
