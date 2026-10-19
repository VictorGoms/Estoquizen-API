-- EQZ-23: motivo estruturado na saída (todos os planos) e custo no produto, base do relatório de
-- perdas. "Venda/uso" fica marcado por padrão: saída sem motivo vira 'venda'. Entradas ficam sem
-- motivo; a contagem do dia grava 'ajuste_contagem'. A leitura de nota preenche o custo com o
-- preço de compra da nota.

alter table public.movements add column if not exists motivo text;
alter table public.movements add constraint movements_motivo_check check (
  motivo is null or motivo in ('venda', 'perda', 'vencido', 'furto', 'uso_interno', 'devolucao', 'ajuste_contagem')
);
comment on column public.movements.motivo is
  'Motivo da saída: venda, perda, vencido, furto, uso_interno, devolucao ou ajuste_contagem (null nas entradas)';

-- Os ajustes da contagem que já existem
update public.movements set motivo = 'ajuste_contagem' where reason = 'Ajuste de contagem' and motivo is null;

alter table public.products add column if not exists cost numeric(12,2) check (cost is null or cost >= 0);
comment on column public.products.cost is 'Custo unitário de compra (opcional); a leitura de nota preenche com o preço da nota';
grant insert (cost), update (cost) on public.products to authenticated;

-- Nova versão do ajuste com o motivo (p_motivo obrigatório, para não haver ambiguidade com a versão
-- antiga, que continua para quem chama sem motivo, como o estoque inicial do cadastro)
create or replace function public.adjust_product_qty(
  p_product_id uuid,
  p_delta      numeric,
  p_motivo     text,
  p_reason     text default null,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_qty   numeric(12,3);
  v_workspace uuid;
  v_motivo    text;
begin
  v_motivo := case when p_delta < 0 then coalesce(p_motivo, 'venda') else null end;
  if v_motivo is not null and v_motivo not in ('venda', 'perda', 'vencido', 'furto', 'uso_interno', 'devolucao') then
    raise exception 'Motivo de saída inválido' using errcode = '22023';
  end if;

  select workspace_id into v_workspace from public.products where id = p_product_id;
  if not found then
    raise exception 'Produto não encontrado';
  end if;

  if v_workspace not in (select public.my_workspace_ids()) then
    raise exception 'Acesso negado';
  end if;

  if not public.workspace_is_writable(v_workspace) then
    raise exception 'Este workspace está em modo somente leitura. Assine um plano para voltar a editar.'
      using errcode = '42501';
  end if;

  update public.products
     set qty = qty + p_delta, updated_at = now()
   where id = p_product_id
     and qty + p_delta >= 0
  returning qty into v_new_qty;

  if not found then
    raise exception 'Estoque insuficiente';
  end if;

  insert into public.movements (product_id, delta, reason, motivo, created_by)
  values (p_product_id, p_delta, p_reason, v_motivo, coalesce(auth.uid(), p_user_id));

  return jsonb_build_object('qty', v_new_qty);
end;
$$;

revoke execute on function public.adjust_product_qty(uuid, numeric, text, text, uuid) from public, anon;
grant  execute on function public.adjust_product_qty(uuid, numeric, text, text, uuid) to authenticated;

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
    insert into movements (product_id, delta, reason, motivo, created_by)
    values (p_product_id, v_delta, 'Ajuste de contagem', 'ajuste_contagem', auth.uid());
  end if;

  return jsonb_build_object('esperado', v_qty, 'contado', v_counted, 'ajuste', v_delta);
end;
$$;

create or replace function public.import_nota_fiscal(
  p_workspace_id uuid,
  p_chave        text,
  p_tipo         text,
  p_itens        jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_prev    timestamptz;
  v_reason  text;
  v_item    jsonb;
  v_product uuid;
  v_qty     numeric;
  v_created int := 0;
  v_updated int := 0;
  v_plan    text;
  v_mes     int;
begin
  if v_user is null then
    raise exception 'Não autenticado';
  end if;
  if p_workspace_id not in (select my_admin_workspace_ids()) then
    raise exception 'Acesso negado';
  end if;
  if not workspace_is_writable(p_workspace_id) then
    raise exception 'Este workspace está em modo somente leitura. Assine um plano para voltar a editar.'
      using errcode = '42501';
  end if;
  -- Trava o workspace: duas importações ao mesmo tempo não passam juntas da cota do mês
  select plan into v_plan from workspaces where id = p_workspace_id for update;
  if v_plan not in ('growth', 'pro') then
    select count(*) into v_mes
      from nota_imports
     where workspace_id = p_workspace_id
       and created_at >= (date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo');
    if v_mes >= 2 then
      raise exception 'O plano Basic lê até 2 notas de compra por mês, e as deste mês já foram usadas. Para ler mais, mude para o Growth.'
        using errcode = '42501';
    end if;
  end if;
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A nota não tem itens para importar';
  end if;

  v_reason := case when p_tipo = 'xml' then 'NF-e' else 'NFC-e' end
              || coalesce(' ' || left(p_chave, 8) || '…', '');

  if p_chave is not null then
    select created_at into v_prev
      from nota_imports
     where workspace_id = p_workspace_id and chave = p_chave;
    if found then
      raise exception 'Esta nota já foi importada em %.',
        to_char(v_prev at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI')
        using errcode = '23505';
    end if;
  end if;

  -- Toda importação fica registrada (conta na cota do mês). O CHECK exige 44 dígitos: sem chave,
  -- grava 44 dígitos aleatórios começando com "00" (chave real começa com o código da UF, 11 a 53),
  -- que nunca colidem com a checagem de nota repetida.
  insert into nota_imports (workspace_id, chave, tipo, itens, imported_by)
  values (p_workspace_id,
          coalesce(p_chave,
                   '00' || lpad(floor(random() * 1e15)::bigint::text, 15, '0')
                        || lpad(floor(random() * 1e15)::bigint::text, 15, '0')
                        || lpad(floor(random() * 1e12)::bigint::text, 12, '0')),
          p_tipo, jsonb_array_length(p_itens), v_user);

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantidade inválida no item "%"', v_item->>'name';
    end if;

    v_product := null;
    if nullif(v_item->>'product_id', '') is not null then
      update products
         set qty        = qty + v_qty,
             price      = coalesce((v_item->>'price')::numeric, price),
             cost       = coalesce((v_item->>'price')::numeric, cost),
             updated_at = now()
       where id = (v_item->>'product_id')::uuid
         and workspace_id = p_workspace_id
      returning id into v_product;
      if v_product is null then
        raise exception 'Produto não encontrado';
      end if;
      v_updated := v_updated + 1;
    else
      insert into products (workspace_id, name, source_name, code, unit, price, cost, qty, created_by)
      values (
        p_workspace_id,
        v_item->>'name',
        v_item->>'name',
        coalesce(nullif(v_item->>'code', ''),
                 'AUTO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
        coalesce(nullif(v_item->>'unit', ''), 'un'),
        coalesce((v_item->>'price')::numeric, 0),
        (v_item->>'price')::numeric,
        v_qty,
        v_user
      )
      returning id into v_product;
      v_created := v_created + 1;
    end if;

    insert into movements (product_id, delta, reason, created_by)
    values (v_product, v_qty, v_reason, v_user);
  end loop;

  return jsonb_build_object('criados', v_created, 'atualizados', v_updated);
end;
$$;
