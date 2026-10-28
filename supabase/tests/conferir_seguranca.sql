-- Conferência de segurança do banco (EQZ-59, auditoria de 2026-10-23; run-2 em 2026-10-24). SÓ LEITURA.
-- Roda no SQL Editor do Supabase ou pelo MCP (execute_sql). Termina SEMPRE com um erro de propósito:
-- assim nada fica gravado nem com a troca de papel; a resposta está na mensagem do erro:
--   "CONFERENCIA OK"  ou  "CONFERENCIA FALHOU (n problemas): <o que falhou> | ...".
-- Rodar depois de cada migração que mexa em GRANT, policy, função ou Storage.
-- Em 2026-10-24, antes das migrações 20261024*, deu 25 problemas.
do $conferencia$
declare
  falhas text[] := '{}';
  t record; par record; pares jsonb := '[]'; n int;
begin
  -- 1) Cada tabela do public: RLS ligada; sem policy = sem GRANT para o cliente; anon não lê nada
  for t in select c.oid, c.relname, c.relrowsecurity,
                  exists (select 1 from pg_policy p where p.polrelid = c.oid) as tem_policy
             from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r' loop
    if not t.relrowsecurity then falhas := falhas || format('RLS desligada em %s', t.relname); end if;
    if not t.tem_policy and (has_table_privilege('authenticated', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                             or has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE')) then
      falhas := falhas || format('%s sem policy e com GRANT', t.relname);
    end if;
    if has_table_privilege('anon', t.oid, 'SELECT') then falhas := falhas || format('anon lê %s', t.relname); end if;
  end loop;

  -- 2) Colunas e tabelas que o cliente não pode tocar
  if has_column_privilege('authenticated', 'public.profiles', 'cpf', 'SELECT') then falhas := falhas || 'cliente lê profiles.cpf'::text; end if;
  if has_column_privilege('authenticated', 'public.profiles', 'cpf', 'UPDATE') then falhas := falhas || 'cliente grava profiles.cpf'::text; end if;
  if has_column_privilege('authenticated', 'public.workspaces', 'plan', 'UPDATE') then falhas := falhas || 'cliente troca workspaces.plan'::text; end if;
  if has_column_privilege('authenticated', 'public.products', 'qty', 'UPDATE') then falhas := falhas || 'cliente grava products.qty'::text; end if;
  if has_table_privilege('authenticated', 'public.workspace_members', 'INSERT') then falhas := falhas || 'cliente insere workspace_members'::text; end if;
  if has_table_privilege('authenticated', 'public.movements', 'INSERT') then falhas := falhas || 'cliente insere movements'::text; end if;

  -- 3) SECURITY DEFINER: search_path fixo e nenhuma executável por anon
  for t in select p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec
             from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.prosecdef loop
    if t.proconfig is null or not exists (select 1 from unnest(t.proconfig) c where c like 'search_path=%') then
      falhas := falhas || format('%s é SECURITY DEFINER sem search_path', t.proname);
    end if;
    if t.anon_exec then falhas := falhas || format('anon executa %s', t.proname); end if;
  end loop;

  -- 4) Travas que precisam existir
  if not exists (select 1 from pg_trigger where tgname = 'protect_workspace_owner')   then falhas := falhas || 'falta a trigger protect_workspace_owner'::text; end if;
  if not exists (select 1 from pg_trigger where tgname = 'protect_invite_acceptance') then falhas := falhas || 'falta a trigger protect_invite_acceptance (EQZ-56)'::text; end if;
  if not exists (select 1 from pg_trigger where tgname = 'products_plan_limit')       then falhas := falhas || 'falta a trigger products_plan_limit'::text; end if;
  if to_regclass('public.desistencias_user_id_unico') is null then falhas := falhas || 'falta o índice único de desistencias (EQZ-58)'::text; end if;
  if to_regclass('public.stripe_events')  is null then falhas := falhas || 'falta a tabela stripe_events (EQZ-59)'::text; end if;
  if to_regclass('public.catalogo_sefaz') is null then falhas := falhas || 'falta a tabela catalogo_sefaz (EQZ-60)'::text; end if;
  if not exists (select 1 from pg_constraint where conname = 'workspaces_nome_sem_tag') then
    falhas := falhas || 'falta a trava de < > no nome do workspace (e-mail de convite)'::text;
  end if;
  -- Buckets de fotos: tamanho e tipos limitados (EQZ-64)
  for t in select id from storage.buckets
            where file_size_limit is null or file_size_limit > 5242880
               or allowed_mime_types is null or not (allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']) loop
    falhas := falhas || format('bucket %s sem limite de tamanho ou com tipos além de JPG/PNG/WebP', t.id);
  end loop;
  if not exists (select 1 from pg_proc where proname = 'accept_workspace_invite' and pronargs = 1) then
    falhas := falhas || 'falta accept_workspace_invite(p_workspace_id) (EQZ-56)'::text;
  end if;

  -- Pares (dono ativo, convidado só pendente) para a simulação abaixo, lidos antes de trocar de papel
  select coalesce(jsonb_agg(jsonb_build_object('dono', o.user_id, 'convidado', m.user_id)), '[]') into pares
    from (select distinct on (m.user_id) m.user_id, m.workspace_id from public.workspace_members m where m.status = 'pendente') m
    join public.workspace_members o on o.workspace_id = m.workspace_id and o.status = 'ativo' and o.role in ('owner', 'admin')
   where not exists (select 1 from public.workspace_members a join public.workspace_members b on b.workspace_id = a.workspace_id
                      where a.user_id = o.user_id and a.status = 'ativo' and b.user_id = m.user_id and b.status = 'ativo')
   limit 20;

  -- 5) Como visitante (anon): não lista o Storage
  set local role anon;
  select count(*) into n from storage.objects where bucket_id in ('product-images', 'profile-images');
  if n > 0 then falhas := falhas || format('anon lista %s arquivos do Storage', n); end if;

  -- 6) Como dono: convidado só pendente não aparece em profiles (EQZ-54)
  set local role authenticated;
  n := 0;
  for par in select * from jsonb_to_recordset(pares) as x(dono uuid, convidado uuid) loop
    perform set_config('request.jwt.claims', json_build_object('sub', par.dono, 'role', 'authenticated')::text, true);
    if exists (select 1 from public.profiles where id = par.convidado) then n := n + 1; end if;
  end loop;
  if n > 0 then falhas := falhas || format('%s de %s pares: dono vê o perfil do convidado pendente', n, jsonb_array_length(pares)); end if;

  if array_length(falhas, 1) is null then
    raise exception 'CONFERENCIA OK (% pares de convite simulados)', jsonb_array_length(pares);
  end if;
  raise exception 'CONFERENCIA FALHOU (% problemas): %', array_length(falhas, 1), array_to_string(falhas, ' | ');
end
$conferencia$;
