-- SCRUM-50: o mesmo usuário ganhava trial em todo workspace novo. A checagem da API usava um
-- embed workspace_members -> subscriptions que não existe; o erro virava "nunca teve trial".
-- Também não dava para confiar em profiles.cpf: a policy de UPDATE deixa o próprio usuário editar.
--
-- trial_grants registra cada trial concedido. Os índices únicos (usuário e hash do CPF) tornam a
-- concessão atômica: a API tenta inserir e, se der conflito, cria sem trial. O CPF fica só como
-- SHA-256. RLS ligado e sem policies: só o service_role (API) lê e grava. O registro continua
-- mesmo depois de o workspace ser excluído, para não liberar outro trial.
create table if not exists public.trial_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  cpf_hash     text,
  workspace_id uuid,
  granted_at   timestamptz not null default now()
);

create unique index if not exists trial_grants_user_id_key  on public.trial_grants (user_id);
create unique index if not exists trial_grants_cpf_hash_key on public.trial_grants (cpf_hash) where cpf_hash is not null;

alter table public.trial_grants enable row level security;
revoke all on public.trial_grants from anon, authenticated;

-- Trials já concedidos: um por usuário (o primeiro), com o hash do CPF do perfil
insert into public.trial_grants (user_id, cpf_hash, workspace_id, granted_at)
select distinct on (w.created_by)
       w.created_by,
       case when p.cpf is not null then encode(extensions.digest(p.cpf, 'sha256'), 'hex') end,
       w.id,
       s.created_at
  from public.subscriptions s
  join public.workspaces w on w.id = s.workspace_id
  left join public.profiles p on p.id = w.created_by
 where s.trial_ends_at is not null
   and w.created_by is not null
 order by w.created_by, s.created_at
on conflict do nothing;
