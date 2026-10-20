-- EQZ-30: ícone do produto. O app escolhe o ícone pelo nome (lista de sinônimos no front); esta
-- coluna só guarda a escolha manual: o nome de um ícone (ex. 'queijo') ou 'nenhum' para ficar só
-- com as iniciais. null = automático. A foto (image_url) continua tendo prioridade.
alter table public.products
  add column if not exists icon text check (icon is null or icon ~ '^[a-z]{2,20}$');

comment on column public.products.icon is
  'Ícone escolhido à mão (nome do ícone ou ''nenhum''); null = automático pelo nome do produto';

grant insert (icon), update (icon) on public.products to authenticated;
