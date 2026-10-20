-- SCRUM-62: cadastrar e editar produto passa a ser só de dono e admin também no banco (antes só a
-- tela barrava, e a policy deixava qualquer membro). Entrada, saída, contagem e importações seguem
-- pelas RPCs SECURITY DEFINER (adjust_product_qty, register_stock_count, import_products,
-- import_nota_fiscal), que não passam por estas policies.

alter policy "Membro cria produtos" on public.products
  with check (
    workspace_id in (select public.my_admin_workspace_ids())
    and public.workspace_is_writable(workspace_id)
    and created_by = auth.uid()
  );
alter policy "Membro cria produtos" on public.products rename to "Admin/Owner cria produtos";

alter policy "Membro atualiza produtos" on public.products
  using (
    workspace_id in (select public.my_admin_workspace_ids())
    and public.workspace_is_writable(workspace_id)
  );
alter policy "Membro atualiza produtos" on public.products rename to "Admin/Owner atualiza produtos";
