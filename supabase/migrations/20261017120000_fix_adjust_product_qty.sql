-- SCRUM-41: entrada/saída de estoque quebrada.
--
-- Na migração de quantidades decimais (abr/2026) foi criada a versão de
-- adjust_product_qty com p_delta numeric, mas a versão antiga (p_delta integer)
-- não foi removida. Com duas funções de mesmo nome e mesmos parâmetros, o
-- PostgREST não sabe qual chamar e responde PGRST203 em toda chamada — nenhuma
-- entrada/saída funcionava e o estoque inicial de produto novo ficava 0.

drop function if exists public.adjust_product_qty(uuid, integer, text, uuid);

-- Recria a versão numeric com dois ajustes:
--   * o autor da movimentação vem do JWT (auth.uid()); p_user_id só é usado
--     quando não há usuário na sessão (chamada com service role). Antes, quem
--     chamasse a RPC direto podia registrar a movimentação em nome de outro;
--   * search_path fixo (alerta "function_search_path_mutable" do Security Advisor).
create or replace function public.adjust_product_qty(
  p_product_id uuid,
  p_delta      numeric,
  p_reason     text default null,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_new_qty   numeric(12,3);
  v_workspace uuid;
begin
  select workspace_id into v_workspace from public.products where id = p_product_id;
  if not found then
    raise exception 'Produto não encontrado';
  end if;

  if v_workspace not in (select public.my_workspace_ids()) then
    raise exception 'Acesso negado';
  end if;

  update public.products
     set qty = qty + p_delta, updated_at = now()
   where id = p_product_id
     and qty + p_delta >= 0
  returning qty into v_new_qty;

  if not found then
    raise exception 'Estoque insuficiente';
  end if;

  insert into public.movements (product_id, delta, reason, created_by)
  values (p_product_id, p_delta, p_reason, coalesce(auth.uid(), p_user_id));

  return jsonb_build_object('qty', v_new_qty);
end;
$$;
