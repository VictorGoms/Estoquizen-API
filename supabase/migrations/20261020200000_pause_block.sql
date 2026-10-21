-- EQZ-07, ajuste do João (2026-10-20): a pausa deixa de ser "1 mês grátis com o app aberto".
-- A pessoa usa até o fim do mês que já pagou; depois o workspace fica bloqueado por 1 ou 2 meses,
-- sem cobrança (pause_collection do Stripe com faturas anuladas), e volta sozinho quando a
-- cobrança recomeça. pause_starts_at/pause_ends_at marcam o período bloqueado; paused_until
-- continua sendo quando o Stripe volta a cobrar.
alter table public.subscriptions
  add column if not exists pause_starts_at timestamptz,
  add column if not exists pause_ends_at   timestamptz;

-- Durante o período da pausa ninguém grava (mesma regra para policies, RPCs e storage)
create or replace function public.workspace_is_writable(p_workspace_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
    when s.workspace_id is null then w.created_at < '2026-10-01T00:00:00Z'
    when s.pause_starts_at is not null and s.pause_ends_at is not null
         and now() >= s.pause_starts_at and now() < s.pause_ends_at then false
    when s.status = 'trialing' then s.trial_ends_at is null or s.trial_ends_at >= now()
    else s.status in ('active', 'past_due')
  end
  from workspaces w
  left join subscriptions s on s.workspace_id = w.id
  where w.id = p_workspace_id
    and w.id in (select my_workspace_ids())
$function$;
