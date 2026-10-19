-- EQZ-17: contagem do dia. Cada contagem fica registrada (o que o sistema esperava × o que a
-- pessoa contou) para a "confiabilidade do estoque" e a sequência de dias. Se não bater, a RPC
-- corrige o estoque e grava a movimentação "Ajuste de contagem", tudo numa transação.

create table if not exists public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  counted_by   uuid references auth.users(id) on delete set null,
  expected_qty numeric(12,3) not null,
  counted_qty  numeric(12,3) not null check (counted_qty >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists stock_counts_workspace_created_idx
  on public.stock_counts (workspace_id, created_at desc);

alter table public.stock_counts enable row level security;

create policy "Membro vê contagens do workspace" on public.stock_counts
  for select using (workspace_id in (select my_workspace_ids()));

-- Só a RPC grava
revoke insert, update, delete on public.stock_counts from anon, authenticated;

create or replace function public.register_stock_count(p_product_id uuid, p_counted numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws      uuid;
  v_qty     numeric(12,3);
  v_plan    text;
  v_counted numeric(12,3);
  v_delta   numeric(12,3);
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'Quantidade contada inválida' using errcode = '22003';
  end if;

  -- Trava o produto: uma entrada ou saída ao mesmo tempo não se perde no meio da contagem
  select workspace_id, qty into v_ws, v_qty from products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado';
  end if;
  if v_ws not in (select my_workspace_ids()) then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if not workspace_is_writable(v_ws) then
    raise exception 'Este workspace está em modo somente leitura. Assine um plano para voltar a editar.'
      using errcode = '42501';
  end if;
  select plan into v_plan from workspaces where id = v_ws;
  if v_plan not in ('growth', 'pro') then
    raise exception 'A contagem do dia está nos planos Growth e Pro.' using errcode = '42501';
  end if;

  v_counted := round(p_counted, 3);
  insert into stock_counts (workspace_id, product_id, counted_by, expected_qty, counted_qty)
  values (v_ws, p_product_id, auth.uid(), v_qty, v_counted);

  v_delta := v_counted - v_qty;
  if v_delta <> 0 then
    update products set qty = v_counted, updated_at = now() where id = p_product_id;
    insert into movements (product_id, delta, reason, created_by)
    values (p_product_id, v_delta, 'Ajuste de contagem', auth.uid());
  end if;

  return jsonb_build_object('esperado', v_qty, 'contado', v_counted, 'ajuste', v_delta);
end;
$$;

revoke execute on function public.register_stock_count(uuid, numeric) from public, anon;
grant  execute on function public.register_stock_count(uuid, numeric) to authenticated;
