-- ============================================================
--  Estoquizen — Schema principal
--  Cole este arquivo no Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ── Extensões ────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ============================================================
--  PROFILES
--  Espelho público do auth.users (criado automaticamente pelo trigger abaixo)
-- ============================================================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text,
  email        text,
  phone        text,
  avatar_color text default 'rgba(37,99,235,0.5)',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- Trigger: cria profile automaticamente quando usuário se registra
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
--  WORKSPACES
-- ============================================================
create table if not exists public.workspaces (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  plan        text not null default 'basic' check (plan in ('basic', 'intermediate', 'pro')),
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ============================================================
--  WORKSPACE_MEMBERS
-- ============================================================
create table if not exists public.workspace_members (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status       text not null default 'pendente' check (status in ('ativo', 'pendente', 'inativo')),
  invited_by   uuid references auth.users(id),
  created_at   timestamptz default now(),
  unique (workspace_id, user_id)
);

-- ============================================================
--  PRODUCTS
-- ============================================================
create table if not exists public.products (
  id           uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  source_name  text,             -- nome original na criação (imutável) — usado para matching de NFC-e
  code         text not null,
  category     text not null default '',
  unit         text not null default 'un',
  price        numeric(12, 2) not null default 0 check (price >= 0),
  qty          integer not null default 0 check (qty >= 0),
  min_qty      integer not null default 0,
  max_qty      integer,
  location     text,
  supplier     text,
  image_url    text,
  nota_fiscal  text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (workspace_id, code)
);

-- ============================================================
--  MOVEMENTS (histórico de entradas e saídas)
-- ============================================================
create table if not exists public.movements (
  id         uuid primary key default uuid_generate_v4(),
  product_id uuid not null references public.products(id) on delete cascade,
  delta      integer not null,   -- positivo = entrada, negativo = saída
  reason     text,               -- ex: "NF-e 35240312345678", "Retirada manutenção"
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ============================================================
--  RLS — Row Level Security
--  Regra geral: usuário só vê dados dos workspaces em que é membro ativo
-- ============================================================

alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.products          enable row level security;
alter table public.movements         enable row level security;

-- Helper: retorna os workspace_ids em que o usuário autenticado é membro ativo
create or replace function public.my_workspace_ids()
returns setof uuid as $$
  select workspace_id
  from public.workspace_members
  where user_id = auth.uid() and status = 'ativo';
$$ language sql security definer stable;

-- Helper: retorna os workspace_ids em que o usuário é owner ou admin ativo
create or replace function public.my_admin_workspace_ids()
returns setof uuid as $$
  select workspace_id
  from public.workspace_members
  where user_id = auth.uid()
    and role in ('owner', 'admin')
    and status = 'ativo';
$$ language sql security definer stable;

-- ── Drop policies existentes (idempotente) ───────────────────
drop policy if exists "Usuário vê seu próprio perfil"            on public.profiles;
drop policy if exists "Usuário atualiza seu próprio perfil"      on public.profiles;
drop policy if exists "Membro vê seus workspaces"                on public.workspaces;
drop policy if exists "Usuário vê workspace de convite pendente" on public.workspaces;
drop policy if exists "Membro pode atualizar workspace (owner/admin)" on public.workspaces;
drop policy if exists "Membro vê outros membros do mesmo workspace"  on public.workspace_members;
drop policy if exists "Usuário vê seus próprios memberships"         on public.workspace_members;
drop policy if exists "Admin/Owner gerencia membros"                  on public.workspace_members;
drop policy if exists "Usuário aceita próprio convite"               on public.workspace_members;
drop policy if exists "Usuário recusa próprio convite"               on public.workspace_members;
drop policy if exists "Membro vê produtos do workspace"              on public.products;
drop policy if exists "Membro cria produtos"                         on public.products;
drop policy if exists "Membro atualiza produtos"                     on public.products;
drop policy if exists "Admin/Owner deleta produtos"                  on public.products;
drop policy if exists "Membro vê movimentações do workspace"         on public.movements;
drop policy if exists "Membro registra movimentações"                on public.movements;

-- ── profiles ─────────────────────────────────────────────────
create policy "Usuário vê seu próprio perfil"
  on public.profiles for select
  using (
    id = auth.uid()
    or id in (
      select user_id from public.workspace_members
      where workspace_id in (select public.my_workspace_ids())
    )
  );

create policy "Usuário atualiza seu próprio perfil"
  on public.profiles for update
  using (id = auth.uid());

-- ── workspaces ───────────────────────────────────────────────
create policy "Membro vê seus workspaces"
  on public.workspaces for select
  using (id in (select public.my_workspace_ids()));

create policy "Usuário vê workspace de convite pendente"
  on public.workspaces for select
  using (
    id in (
      select workspace_id from public.workspace_members
      where user_id = auth.uid()
        and status = 'pendente'
    )
  );

create policy "Membro pode atualizar workspace (owner/admin)"
  on public.workspaces for update
  using (id in (select public.my_admin_workspace_ids()));

-- ── workspace_members ────────────────────────────────────────
create policy "Membro vê outros membros do mesmo workspace"
  on public.workspace_members for select
  using (workspace_id in (select public.my_workspace_ids()));

-- Usuário vê seus próprios convites/memberships (inclusive pendentes)
create policy "Usuário vê seus próprios memberships"
  on public.workspace_members for select
  using (user_id = auth.uid());

create policy "Admin/Owner gerencia membros"
  on public.workspace_members for all
  using (workspace_id in (select public.my_admin_workspace_ids()));

-- Usuário aceita próprio convite pendente
create policy "Usuário aceita próprio convite"
  on public.workspace_members for update
  using  (user_id = auth.uid() and status = 'pendente')
  with check (status = 'ativo');

-- Usuário recusa/deleta próprio convite pendente
create policy "Usuário recusa próprio convite"
  on public.workspace_members for delete
  using (user_id = auth.uid() and status = 'pendente');

-- ── products ─────────────────────────────────────────────────
create policy "Membro vê produtos do workspace"
  on public.products for select
  using (workspace_id in (select public.my_workspace_ids()));

create policy "Membro cria produtos"
  on public.products for insert
  with check (workspace_id in (select public.my_workspace_ids()));

create policy "Membro atualiza produtos"
  on public.products for update
  using (workspace_id in (select public.my_workspace_ids()));

create policy "Admin/Owner deleta produtos"
  on public.products for delete
  using (workspace_id in (select public.my_admin_workspace_ids()));

-- ── movements ────────────────────────────────────────────────
create policy "Membro vê movimentações do workspace"
  on public.movements for select
  using (
    product_id in (
      select id from public.products
      where workspace_id in (select public.my_workspace_ids())
    )
  );

create policy "Membro registra movimentações"
  on public.movements for insert
  with check (
    product_id in (
      select id from public.products
      where workspace_id in (select public.my_workspace_ids())
    )
  );

-- ============================================================
--  FUNÇÃO: adjust_product_qty
--  Ajusta estoque e registra movimento em transação única.
--  Resolve: race condition (#2) e divergência qty/movements (#1).
--
--  SECURITY INVOKER → RLS do usuário se aplica dentro da função.
--  O UPDATE usa "qty + p_delta" diretamente, sem leitura prévia.
-- ============================================================
create or replace function public.adjust_product_qty(
  p_product_id uuid,
  p_delta      integer,
  p_reason     text    default null,
  p_user_id    uuid    default null
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_new_qty    integer;
  v_workspace  uuid;
begin
  -- Verifica que o produto pertence a um workspace do usuário autenticado
  -- (defesa explícita, independente do RLS)
  select workspace_id into v_workspace
  from   public.products
  where  id = p_product_id;

  if not found then
    raise exception 'Produto não encontrado';
  end if;

  if v_workspace not in (select public.my_workspace_ids()) then
    raise exception 'Acesso negado';
  end if;

  -- Atualiza qty atomicamente (sem leitura prévia → sem race condition)
  update public.products
  set    qty        = qty + p_delta,
         updated_at = now()
  where  id = p_product_id
    and  qty + p_delta >= 0
  returning qty into v_new_qty;

  if not found then
    raise exception 'Estoque insuficiente';
  end if;

  -- Registra movimentação na mesma transação
  insert into public.movements (product_id, delta, reason, created_by)
  values (p_product_id, p_delta, p_reason, p_user_id);

  return jsonb_build_object('qty', v_new_qty);
end;
$$;

-- ============================================================
--  ÍNDICES (performance)
-- ============================================================
create index if not exists idx_workspace_members_user     on public.workspace_members(user_id);
create index if not exists idx_workspace_members_workspace on public.workspace_members(workspace_id);
create index if not exists idx_products_workspace          on public.products(workspace_id);
create index if not exists idx_products_code               on public.products(workspace_id, code);
create index if not exists idx_movements_product           on public.movements(product_id);
create index if not exists idx_movements_created_at        on public.movements(created_at desc);
