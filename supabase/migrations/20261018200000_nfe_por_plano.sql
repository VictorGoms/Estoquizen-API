-- SCRUM-57: a tela de planos promete a importação de nota (NFC-e e XML) só no Growth e no Pro,
-- mas o Basic importava normalmente. A API checa o plano (plans.ts: nfe) e a RPC também,
-- para valer na chamada direta. Mesmo corpo da migração rls_hardening + a checagem do plano.
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
  if (select plan from workspaces where id = p_workspace_id) not in ('growth', 'pro') then
    raise exception 'A importação de nota não faz parte do plano Basic. Ela está nos planos Growth e Pro.'
      using errcode = '42501';
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

    insert into nota_imports (workspace_id, chave, tipo, itens, imported_by)
    values (p_workspace_id, p_chave, p_tipo, jsonb_array_length(p_itens), v_user);
  end if;

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
             updated_at = now()
       where id = (v_item->>'product_id')::uuid
         and workspace_id = p_workspace_id
      returning id into v_product;
      if v_product is null then
        raise exception 'Produto não encontrado';
      end if;
      v_updated := v_updated + 1;
    else
      insert into products (workspace_id, name, source_name, code, unit, price, qty, created_by)
      values (
        p_workspace_id,
        v_item->>'name',
        v_item->>'name',
        coalesce(nullif(v_item->>'code', ''),
                 'AUTO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
        coalesce(nullif(v_item->>'unit', ''), 'un'),
        coalesce((v_item->>'price')::numeric, 0),
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
