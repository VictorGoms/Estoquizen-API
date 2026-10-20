-- EQZ-13: "Qual é o seu negócio?" no cadastro da empresa. O segmento ordena os atalhos de
-- unidade no cadastro de produto, oferece uma lista pronta de produtos do ramo e vai virar
-- propriedade no analytics (comparar retenção por nicho). segment_other guarda o
-- "Outro (escreva)", para descobrir os próximos nichos.
alter table public.workspaces
  add column if not exists segment       text check (segment in ('mercearia', 'bar', 'buffet', 'roupas', 'pet', 'oficina', 'outro')),
  add column if not exists segment_other text check (char_length(segment_other) <= 60);

-- workspaces usa GRANT por coluna desde o SCRUM-48: o cliente lê o segmento e o dono/admin troca
-- em Configurações (a policy de update continua decidindo quem pode)
grant select (segment, segment_other), update (segment, segment_other) on public.workspaces to authenticated;
