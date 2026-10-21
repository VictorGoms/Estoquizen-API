-- Lista de compras: itens adicionados à mão (pedido do João em 2026-10-21). A lista automática
-- (no mínimo ou acabando em 7 dias) continua calculada no front; aqui ficam os que a pessoa põe
-- mesmo sem estar no mínimo. Compartilhada pela equipe; um item por produto. A API apaga o item
-- quando chega uma entrada do produto depois de ele ser adicionado (foi comprado).
create table if not exists public.shopping_list_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  qty          numeric(12,3) not null check (qty > 0 and qty <= 999999999),
  added_by     uuid not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, product_id)
);

alter table public.shopping_list_items enable row level security;

-- Membros leem; gravar só pela API (service_role), que confere membro e assinatura
create policy "Membro vê a lista de compras" on public.shopping_list_items
  for select using (workspace_id in (select public.my_workspace_ids()));

create index if not exists shopping_list_items_ws on public.shopping_list_items (workspace_id);
