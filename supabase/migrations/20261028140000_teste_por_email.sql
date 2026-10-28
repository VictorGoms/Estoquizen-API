-- 1 teste grátis também por e-mail normalizado (pedido do João em 2026-10-28). Até aqui era 1 por conta e 1 por
-- CPF, mas "joao+1@gmail.com" e "j.oao@gmail.com" são contas diferentes que caem na mesma caixa: os 3 testes
-- concedidos até hoje foram para variações do mesmo e-mail. Normalização igual à de `normalizarEmail`
-- (src/lib/trial.ts): minúsculas, sem o "+algo" e, no Gmail/Googlemail, sem pontos e com o domínio gmail.com.
-- Guarda só o SHA-256, como o CPF. Nos testes antigos, só o mais antigo de cada e-mail recebe o hash (os
-- outros ficam vazios), senão o índice único não seria criado.
alter table public.trial_grants add column if not exists email_hash text;

with base as (
  select g.user_id, g.granted_at,
         split_part(split_part(lower(trim(u.email)), '@', 1), '+', 1) as local,
         split_part(lower(trim(u.email)), '@', 2)                      as dominio
    from public.trial_grants g
    join auth.users u on u.id = g.user_id
), normal as (
  select user_id, granted_at,
         case when dominio in ('gmail.com', 'googlemail.com') then replace(local, '.', '') || '@gmail.com'
              else local || '@' || dominio end as email
    from base
), primeiro as (
  select distinct on (email) user_id, email from normal order by email, granted_at
)
update public.trial_grants g
   set email_hash = encode(sha256(convert_to(p.email, 'UTF8')), 'hex')
  from primeiro p
 where g.user_id = p.user_id
   and g.email_hash is null;

create unique index if not exists trial_grants_email_hash_key
  on public.trial_grants (email_hash) where email_hash is not null;
