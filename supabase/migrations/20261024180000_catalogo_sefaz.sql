-- EQZ-60: o catálogo de códigos de barras da EQZ-53 nunca respondeu em produção. A rota procurava os
-- itens em nota_imports.itens, mas essa coluna é integer (a quantidade de itens): o filtro dava 42883 e
-- a rota devolvia null sempre. E os itens de /nfe/importar vêm do cliente, então nenhum nome deles é
-- confiável (bastaria omitir a marca "manual" para envenenar o nome sugerido a todas as empresas).
--
-- Fonte "nota" agora é só o que a própria API leu do portal da SEFAZ em /nfe/consultar: código de
-- barras de verdade (GTIN) + descrição do fornecedor + estado. Sem empresa, preço ou quantidade.
-- XML, item digitado e cadastro continuam valendo só como nome digitado (precisam de 2 donos).
-- Só a API (service role) acessa.
create table if not exists public.catalogo_sefaz (
  codigo  text not null,                  -- GTIN válido (8, 12, 13 ou 14 dígitos)
  nome    text not null,                  -- descrição do item como a SEFAZ mostrou
  uf      text not null,                  -- código do estado (2 primeiros dígitos da chave)
  visto_em timestamptz not null default now(),
  primary key (codigo, nome)
);

alter table public.catalogo_sefaz enable row level security;
revoke all on public.catalogo_sefaz from anon, authenticated;
