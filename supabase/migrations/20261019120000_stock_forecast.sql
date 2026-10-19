-- EQZ-16: previsão "dura ~X dias" (média simples de saídas). Soma as saídas dos últimos 30 dias
-- por produto do workspace; o front divide pelo número de dias de histórico (até 30, mínimo 7)
-- e calcula quantos dias o estoque atual dura. SECURITY INVOKER: a RLS de movements e products
-- vale para quem chama, então só vê o próprio workspace.
create or replace function public.stock_forecast(p_workspace_id uuid)
returns table (product_id uuid, saidas_30d numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select m.product_id, sum(-m.delta) as saidas_30d
    from movements m
    join products p on p.id = m.product_id
   where p.workspace_id = p_workspace_id
     and m.delta < 0
     and m.created_at >= now() - interval '30 days'
   group by m.product_id
$$;

revoke execute on function public.stock_forecast(uuid) from public, anon;
grant  execute on function public.stock_forecast(uuid) to authenticated;
