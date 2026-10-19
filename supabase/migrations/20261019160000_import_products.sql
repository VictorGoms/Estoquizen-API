-- EQZ-14: importar produtos de uma planilha (CSV ou Excel lido no front) numa transação só.
-- Ou entra a planilha inteira ou nada entra: um erro no meio não deixa metade cadastrada.
-- Código que já existe no workspace é pulado (conta em "ignorados"), não duplica nem sobrescreve.
-- Quantidade > 0 vira a movimentação "Estoque inicial (planilha)", como no cadastro manual.
-- O limite de produtos do plano vale pela trigger products_plan_limit.

create or replace function public.import_products(p_workspace_id uuid, p_itens jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_item      jsonb;
  v_code      text;
  v_qty       numeric(12,3);
  v_product   uuid;
  v_criados   int := 0;
  v_ignorados int := 0;
begin
  if v_user is null then
    raise exception 'Não autenticado';
  end if;
  if p_workspace_id not in (select my_admin_workspace_ids()) then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if not workspace_is_writable(p_workspace_id) then
    raise exception 'Este workspace está em modo somente leitura. Assine um plano para voltar a editar.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A planilha não tem produtos para importar' using errcode = '22023';
  end if;
  if jsonb_array_length(p_itens) > 2000 then
    raise exception 'Planilha com produtos demais: importe até 2000 por vez' using errcode = '22023';
  end if;

  -- Trava o workspace: duas importações ao mesmo tempo não passam juntas do limite do plano
  perform 1 from workspaces where id = p_workspace_id for update;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_code := nullif(btrim(v_item->>'code'), '');
    if v_code is not null and exists (
      select 1 from products where workspace_id = p_workspace_id and code = v_code
    ) then
      v_ignorados := v_ignorados + 1;
      continue;
    end if;

    v_qty := round(coalesce((v_item->>'qty')::numeric, 0), 3);
    if v_qty < 0 then
      raise exception 'Quantidade negativa no produto "%"', v_item->>'name' using errcode = '22023';
    end if;

    insert into products (
      workspace_id, name, source_name, code, unit, price, cost, min_qty, max_qty,
      category, supplier, location, qty, created_by
    )
    values (
      p_workspace_id,
      v_item->>'name',
      v_item->>'name',
      coalesce(v_code, 'AUTO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
      coalesce(nullif(btrim(v_item->>'unit'), ''), 'un'),
      round(coalesce((v_item->>'price')::numeric, 0), 2),
      round((v_item->>'cost')::numeric, 2),
      round(coalesce((v_item->>'min_qty')::numeric, 0), 3),
      round((v_item->>'max_qty')::numeric, 3),
      coalesce(nullif(btrim(v_item->>'category'), ''), ''),
      nullif(btrim(v_item->>'supplier'), ''),
      nullif(btrim(v_item->>'location'), ''),
      v_qty,
      v_user
    )
    returning id into v_product;

    if v_qty > 0 then
      insert into movements (product_id, delta, reason, created_by)
      values (v_product, v_qty, 'Estoque inicial (planilha)', v_user);
    end if;
    v_criados := v_criados + 1;
  end loop;

  return jsonb_build_object('criados', v_criados, 'ignorados', v_ignorados);
end;
$$;

revoke execute on function public.import_products(uuid, jsonb) from public, anon;
grant  execute on function public.import_products(uuid, jsonb) to authenticated;
