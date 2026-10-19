-- EQZ-18: "R$ parados" (produtos sem saída há 60 dias). Devolve a data da última saída de cada
-- produto do workspace que já teve alguma; o front decide o que está parado. SECURITY INVOKER:
-- a RLS de movements e products vale para quem chama.
create or replace function public.stock_last_outflow(p_workspace_id uuid)
returns table (product_id uuid, ultima_saida timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select m.product_id, max(m.created_at) as ultima_saida
    from movements m
    join products p on p.id = m.product_id
   where p.workspace_id = p_workspace_id
     and m.delta < 0
   group by m.product_id
$$;

revoke execute on function public.stock_last_outflow(uuid) from public, anon;
grant  execute on function public.stock_last_outflow(uuid) to authenticated;
