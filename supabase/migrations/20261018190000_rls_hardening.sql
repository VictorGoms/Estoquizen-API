-- SCRUM-48: o front gravava direto no Supabase e as policies deixavam fazer o que a API bloqueia:
-- editar em modo somente leitura, trocar o plano do workspace (até para "ilimitado"), criar produto
-- com qty sem movimentação e acima do limite, forjar movimentação, aceitar convite escolhendo o papel
-- e mexer em fotos de qualquer workspace. O front passou a gravar pela API (front dbb6ef3); aqui o
-- banco aplica as mesmas regras, valendo também para quem chama o Supabase direto com o token.
-- Sem DROP: as policies antigas são ajustadas com ALTER POLICY.

-- ── 1. Funções de apoio ──────────────────────────────────────────────────────────────────────

-- Mesma regra do assertActiveSubscription da API: grava quem está em trial válido, ativo ou com
-- pagamento pendente; workspace legado (antes de 2026-10-01) sem assinatura segue liberado
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
$$;

revoke execute on function public.workspace_is_writable(uuid) from public, anon;
grant  execute on function public.workspace_is_writable(uuid) to authenticated;

-- Limite de produtos por plano (mesmos números de src/lib/plans.ts da API)
create or replace function public.plan_product_limit(p_plan text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_plan when 'pro' then 2000 when 'growth' then 300 else 50 end
$$;

-- Vale para todos (API, RPC de nota e escrita direta). Trava a linha do workspace para dois
-- cadastros ao mesmo tempo não passarem juntos do limite.
create or replace function public.enforce_product_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  text;
  v_limit integer;
  v_count integer;
begin
  select plan into v_plan from workspaces where id = new.workspace_id for update;
  v_limit := plan_product_limit(v_plan);
  select count(*) into v_count from products where workspace_id = new.workspace_id;
  if v_count >= v_limit then
    raise exception 'Limite do plano atingido: máximo de % produtos. Faça upgrade para continuar.', v_limit
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_product_limit() from public, anon, authenticated;

create trigger products_plan_limit
  before insert on public.products
  for each row execute function public.enforce_product_limit();

-- Pasta do storage = id de um workspace do qual a pessoa é membro e que aceita escrita
create or replace function public.storage_workspace_writable(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_folder text := (storage.foldername(p_object_name))[1];
begin
  if v_folder is null
     or v_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return v_folder::uuid in (select my_workspace_ids()) and workspace_is_writable(v_folder::uuid);
end;
$$;

revoke execute on function public.storage_workspace_writable(text) from public, anon;
grant  execute on function public.storage_workspace_writable(text) to authenticated;

-- ── 2. workspaces: o plano só muda pelo service_role (webhook do Stripe) ────────────────────

alter table public.workspaces
  add constraint workspaces_plan_check check (plan in ('basic', 'growth', 'pro'));

revoke insert, update, delete on public.workspaces from anon, authenticated;
grant  update (name, description, updated_at) on public.workspaces to authenticated;

alter policy "Membro pode atualizar workspace (owner/admin)" on public.workspaces
  using (id in (select my_admin_workspace_ids()) and workspace_is_writable(id));

-- ── 3. products: qty só pelas RPCs; escrita só com assinatura que permite ───────────────────

revoke insert, update on public.products from anon, authenticated;
revoke delete         on public.products from anon;
grant  insert (workspace_id, name, source_name, code, category, unit, price, min_qty, max_qty,
               location, supplier, image_url, nota_fiscal, created_by)
  on public.products to authenticated;
grant  update (name, code, category, unit, price, min_qty, max_qty, location, supplier,
               image_url, nota_fiscal, updated_at)
  on public.products to authenticated;

alter policy "Membro cria produtos" on public.products
  with check (workspace_id in (select my_workspace_ids())
              and workspace_is_writable(workspace_id)
              and created_by = auth.uid());

alter policy "Membro atualiza produtos" on public.products
  using (workspace_id in (select my_workspace_ids()) and workspace_is_writable(workspace_id));

alter policy "Admin/Owner deleta produtos" on public.products
  using (workspace_id in (select my_admin_workspace_ids()) and workspace_is_writable(workspace_id));

-- ── 4. movements e nota_imports: só as RPCs gravam ─────────────────────────────────────────

revoke insert, update, delete on public.movements    from anon, authenticated;
revoke insert, update, delete on public.nota_imports from anon, authenticated;

-- ── 5. RPCs de estoque: SECURITY DEFINER (o cliente não tem mais escrita em qty/movements),
--       com as checagens de membro e de assinatura dentro ─────────────────────────────────────

create or replace function public.adjust_product_qty(
  p_product_id uuid,
  p_delta      numeric,
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
begin
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

  insert into public.movements (product_id, delta, reason, created_by)
  values (p_product_id, p_delta, p_reason, coalesce(auth.uid(), p_user_id));

  return jsonb_build_object('qty', v_new_qty);
end;
$$;

revoke execute on function public.adjust_product_qty(uuid, numeric, text, uuid) from public, anon;
grant  execute on function public.adjust_product_qty(uuid, numeric, text, uuid) to authenticated;

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

revoke execute on function public.import_nota_fiscal(uuid, text, text, jsonb) from public, anon;
grant  execute on function public.import_nota_fiscal(uuid, text, text, jsonb) to authenticated;

-- ── 6. workspace_members: convite só pela API; quem aceita não escolhe o papel ──────────────

revoke insert, update on public.workspace_members from anon, authenticated;
grant  update (role, status) on public.workspace_members to authenticated;

-- O aceite agora é POST /members/accept (só muda o status) ou a RPC accept_workspace_invite
alter policy "Usuário aceita próprio convite" on public.workspace_members
  using (false) with check (false);

-- ── 7. profiles: só os campos que a própria pessoa edita ────────────────────────────────────

revoke insert, update, delete on public.profiles from anon, authenticated;
grant  update (name, phone, avatar_url, avatar_color, updated_at) on public.profiles to authenticated;

-- ── 8. Storage: foto de produto só na pasta de um workspace do qual a pessoa é membro ───────

alter policy "Autenticado pode fazer upload" on storage.objects
  with check (bucket_id = 'product-images' and public.storage_workspace_writable(name));

alter policy "Membros fazem upload de imagens" on storage.objects
  with check (bucket_id = 'product-images' and public.storage_workspace_writable(name));

alter policy "Autenticado pode atualizar imagem" on storage.objects
  using (bucket_id = 'product-images' and public.storage_workspace_writable(name));

alter policy "Autenticado pode deletar imagem" on storage.objects
  using (bucket_id = 'product-images' and public.storage_workspace_writable(name));
