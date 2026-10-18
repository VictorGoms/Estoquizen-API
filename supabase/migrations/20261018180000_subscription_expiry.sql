-- SCRUM-56: o job de limpeza media "expirou há X dias" pelo updated_at, que muda com qualquer
-- atualização da linha, e mandava o aviso de exclusão todo dia entre o 14º e o 29º dia.
-- Agora cada assinatura guarda quando expirou e quando foi avisada.
alter table public.subscriptions
  add column if not exists expired_at timestamptz,
  add column if not exists warned_at  timestamptz;

comment on column public.subscriptions.expired_at is
  'Quando entrou em trial_expired/canceled (a trigger preenche). Base do aviso (14 dias) e da exclusão (30 dias).';
comment on column public.subscriptions.warned_at is
  'Quando o aviso de exclusão foi enviado. Volta a null quando a assinatura sai do estado expirado.';

create or replace function public.subscriptions_track_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('trial_expired', 'canceled') then
    if tg_op = 'INSERT' or old.status not in ('trial_expired', 'canceled') then
      -- Trial vencido conta a partir do fim do trial, não de quando o job percebeu
      new.expired_at := case
        when tg_op = 'UPDATE' and old.status = 'trialing'
             and new.trial_ends_at is not null and new.trial_ends_at <= now()
          then new.trial_ends_at
        else now()
      end;
      new.warned_at := null;
    end if;
  else
    new.expired_at := null;
    new.warned_at  := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.subscriptions_track_expiry() from public, anon, authenticated;

create trigger subscriptions_track_expiry
  before insert or update of status on public.subscriptions
  for each row execute function public.subscriptions_track_expiry();

-- Linhas que já estão expiradas: usa o updated_at, que era a referência até agora
update public.subscriptions
   set expired_at = updated_at
 where status in ('trial_expired', 'canceled') and expired_at is null;
