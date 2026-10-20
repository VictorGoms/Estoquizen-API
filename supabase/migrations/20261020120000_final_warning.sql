-- Último aviso antes da exclusão (pedido do João em 2026-10-20). Antes saía um aviso só, no 14º dia
-- depois do fim da assinatura. Agora sai também um último aviso 3 dias antes da exclusão, e a
-- exclusão espera pelo menos 3 dias depois dele.
alter table public.subscriptions
  add column if not exists final_warned_at timestamptz;

comment on column public.subscriptions.final_warned_at is
  'Quando o último aviso de exclusão foi enviado (3 dias antes). Volta a null quando a assinatura sai do estado expirado.';

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
      new.warned_at       := null;
      new.final_warned_at := null;
    end if;
  else
    new.expired_at      := null;
    new.warned_at       := null;
    new.final_warned_at := null;
  end if;
  return new;
end;
$$;
