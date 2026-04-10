-- ============================================================
--  Estoquizen — Seed de desenvolvimento
--  ATENÇÃO: rode APÓS o schema.sql
--  Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- 1. Cria o usuário de teste via Supabase Auth
select auth.create_user(
  '00000000-0000-0000-0000-000000000001'::uuid,  -- id fixo para referenciar abaixo
  'joaovictor@teste.com',
  '12345678',
  true,           -- email_confirm = true (pula verificação)
  '{"name": "João Victor"}'::jsonb
);

-- 2. Cria o workspace
insert into public.workspaces (id, name, description, plan, created_by)
values (
  '00000000-0000-0000-0000-000000000010'::uuid,
  'Pizzas do Lar',
  'Workspace de desenvolvimento',
  'pro',
  '00000000-0000-0000-0000-000000000001'
);

-- 3. Vincula o usuário como owner
insert into public.workspace_members (workspace_id, user_id, role, status)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'owner',
  'ativo'
);

-- 4. Produtos de exemplo
insert into public.products (workspace_id, name, code, category, unit, price, qty, min_qty, created_by)
values
  ('00000000-0000-0000-0000-000000000010', 'Farinha de Trigo 5kg',    'FAR-001', 'Insumos',     'sc',  18.90,  40, 10, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000010', 'Molho de Tomate 300g',    'MOL-001', 'Insumos',     'un',   4.50, 120, 30, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000010', 'Mussarela kg',            'MUS-001', 'Laticínios',  'kg',  42.00,  15,  5, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000010', 'Caixa Pizza 35cm',        'CX-035',  'Embalagem',   'un',   1.20, 200, 50, '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000010', 'Caixa Pizza 45cm',        'CX-045',  'Embalagem',   'un',   1.80,   4, 50, '00000000-0000-0000-0000-000000000001');
