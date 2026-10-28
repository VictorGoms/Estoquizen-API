-- EQZ-69 (2026-10-28): entrada ou saída de vários produtos de uma vez (modo "Vários" do Escanear).
-- Uma transação só: grava tudo ou nada. Na saída, se algum produto não tiver o bastante, nada é gravado
-- e a mensagem diz quais (decisão do João: bloquear com aviso). Mesmas regras do adjust_product_qty:
-- qualquer membro ativo, workspace que aceita escrita, motivo da saída (padrão venda).
-- Chamada pela API (POST /products/adjust-batch) com o token da pessoa: auth.uid() é quem registrou.
-- p_itens: [{ "product_id": uuid, "delta": numeric }], todos com o mesmo sinal, sem produto repetido.
create or replace function public.adjust_products_batch(
  p_workspace_id uuid,
  p_itens        jsonb,
  p_motivo       text default null,
  p_reason       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item     jsonb;
  v_id       uuid;
  v_delta    numeric(12,3);
  v_qty      numeric(12,3);
  v_nome     text;
  v_unidade  text;
  v_saida    boolean;
  v_motivo   text;
  v_total    int;
  v_achados  int;
  v_faltam   text[] := '{}';
  v_result   jsonb  := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;
  if p_workspace_id not in (select my_workspace_ids()) then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if not workspace_is_writable(p_workspace_id) then
    raise exception 'Este workspace está em modo somente leitura. Assine um plano para voltar a editar.'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A lista está vazia' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_itens);
  if v_total > 300 then
    raise exception 'Até 300 produtos por vez' using errcode = '22023';
  end if;
  if (select count(distinct e->>'product_id') from jsonb_array_elements(p_itens) e) <> v_total then
    raise exception 'Produto repetido na lista' using errcode = '22023';
  end if;

  v_saida := (p_itens->0->>'delta')::numeric < 0;
  if exists (
    select 1 from jsonb_array_elements(p_itens) e
     where (e->>'delta')::numeric is null or (e->>'delta')::numeric = 0
        or ((e->>'delta')::numeric < 0) <> v_saida
  ) then
    raise exception 'Quantidade inválida na lista' using errcode = '22023';
  end if;

  v_motivo := case when v_saida then coalesce(p_motivo, 'venda') else null end;
  if v_motivo is not null and v_motivo not in ('venda', 'perda', 'vencido', 'furto', 'uso_interno', 'devolucao') then
    raise exception 'Motivo de saída inválido' using errcode = '22023';
  end if;

  -- Trava os produtos da lista, sempre na mesma ordem (dois lotes ao mesmo tempo não se travam),
  -- e confere que todos são deste workspace
  select count(*) into v_achados from (
    select id from products
     where workspace_id = p_workspace_id
       and id in (select (e->>'product_id')::uuid from jsonb_array_elements(p_itens) e)
     order by id
       for update
  ) travados;
  if v_achados <> v_total then
    raise exception 'Produto não encontrado neste workspace' using errcode = 'P0002';
  end if;

  -- Saída: confere todos antes de gravar, para avisar de uma vez o que falta
  if v_saida then
    for v_item in select * from jsonb_array_elements(p_itens) loop
      select qty, name, unit into v_qty, v_nome, v_unidade from products where id = (v_item->>'product_id')::uuid;
      if v_qty + round((v_item->>'delta')::numeric, 3) < 0 then
        v_faltam := v_faltam || format('%s (tem %s %s)', v_nome, replace(trim_scale(v_qty)::text, '.', ','), v_unidade);
      end if;
    end loop;
    if array_length(v_faltam, 1) > 0 then
      raise exception 'Estoque insuficiente: %', array_to_string(v_faltam, '; ') using errcode = 'P0001';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_id    := (v_item->>'product_id')::uuid;
    v_delta := round((v_item->>'delta')::numeric, 3);

    update products set qty = qty + v_delta, updated_at = now()
     where id = v_id
    returning qty into v_qty;

    insert into movements (product_id, delta, reason, motivo, created_by)
    values (v_id, v_delta, p_reason, v_motivo, auth.uid());

    v_result := v_result || jsonb_build_object('product_id', v_id, 'qty', v_qty);
  end loop;

  return jsonb_build_object('itens', v_result);
end;
$$;

revoke all     on function public.adjust_products_batch(uuid, jsonb, text, text) from public, anon;
grant  execute on function public.adjust_products_batch(uuid, jsonb, text, text) to authenticated;
