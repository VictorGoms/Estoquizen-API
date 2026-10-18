-- SCRUM-48 (ajuste): chamada direto por /rest/v1/rpc, workspace_is_writable dizia se a assinatura
-- de qualquer workspace estava ativa. Agora só responde para membros (as policies e as RPCs já
-- exigem ser membro antes de chamar; para quem não é, devolve null, que conta como falso).
create or replace function public.workspace_is_writable(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.workspace_id is null then w.created_at < '2026-10-01T00:00:00Z'
    when s.status = 'trialing' then s.trial_ends_at is null or s.trial_ends_at >= now()
    else s.status in ('active', 'past_due')
  end
  from workspaces w
  left join subscriptions s on s.workspace_id = w.id
  where w.id = p_workspace_id
    and w.id in (select my_workspace_ids())
$$;
