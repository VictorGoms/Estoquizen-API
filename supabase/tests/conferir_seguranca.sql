-- Conferência de segurança do banco (EQZ-59, auditoria de 2026-10-23). SÓ LEITURA.
-- Roda no SQL Editor do Supabase ou pelo MCP (execute_sql). Termina SEMPRE com um erro de propósito:
-- assim nada fica gravado nem com a troca de papel; a resposta está na mensagem do erro:
--   "CONFERENCIA OK (n itens)"  ou  "CONFERENCIA FALHOU: <o que falhou> | ...".
-- Rodar depois de cada migração que mexa em GRANT, policy, função ou Storage.
do $conferencia$
declare
  falhas text[] := '{}';
  itens  int := 0;
  t record;
  par record;
  pares  jsonb := '[]';
  n int;
begin
  -- 1) RLS ligada em toda tabela do public
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    falhas := falhas || format('RLS desligada em %s', t.relname);
  end loop;
  itens := itens + 1;

  -- 2) Tabela sem policy = só a API (service role): nenhum GRANT para anon/authenticated
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r'
              and not exists (select 1 from pg_policy p where p.polrelid = c.oid) loop
    if has_table_privilege('authenticated', format('public.%I', t.relname), 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('anon', format('public.%I', t.relname), 'SELECT,INSERT,UPDATE,DELETE') then
      falhas := falhas || format('%s não tem policy e ainda tem GRANT para o cliente', t.relname);
    end if;
  end loop;
  itens := itens + 1;

  -- 3) Visitante sem login (anon) não lê tabela nenhuma
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r' loop
    if has_table_privilege('anon', format('public.%I', t.relname), 'SELECT') then
      falhas := falhas || format('anon lê %s', t.relname);
    end if;
  end loop;
  itens := itens + 1;

  -- 4) Colunas que o cliente não pode tocar
  if has_column_privilege('authenticated', 'public.profiles', 'cpf', 'SELECT') then falhas := falhas || 'cliente lê profiles.cpf'::text; end if;
  if has_column_privilege('authenticated', 'public.profiles', 'cpf', 'UPDATE') then falhas := falhas || 'cliente grava profiles.cpf'::text; end if;
  if has_column_privilege('authenticated', 'public.workspaces', 'plan', 'UPDATE') then falhas := falhas || 'cliente troca workspaces.plan'::text; end if;
  if has_column_privilege('authenticated', 'public.products', 'qty', 'UPDATE') then falhas := falhas || 'cliente grava products.qty'::text; end if;
  if has_table_privilege('authenticated', 'public.workspace_members', 'INSERT') then falhas := falhas || 'cliente insere workspace_members'::text; end if;
  if has_table_privilege('authenticated', 'public.movements', 'INSERT') then falhas := falhas || 'cliente insere movements'::text; end if;
  itens := itens + 1;

  -- 5) SECURITY DEFINER: search_path fixo e nenhuma executável por anon
  for t in select p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec
             from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.prosecdef loop
    if t.proconfig is null or not exists (select 1 from unnest(t.proconfig) c where c like 'search_path=%') then
      falhas := falhas || format('%s é SECURITY DEFINER sem search_path', t.proname);
    end if;
    if t.anon_exec then falhas := falhas || format('anon executa %s', t.proname); end if;
  end loop;
  itens := itens + 1;

  -- 6) Travas que precisam existir
  if not exists (select 1 from pg_trigger where tgname = 'protect_workspace_owner')   then falhas := falhas || 'falta a trigger protect_workspace_owner'::text; end if;
  if not exists (select 1 from pg_trigger where tgname = 'protect_invite_acceptance') then falhas := falhas || 'falta a trigger protect_invite_acceptance (EQZ-56)'::text; end if;
  if not exists (select 1 from pg_trigger where tgname = 'products_plan_limit')       then falhas := falhas || 'falta a trigger products_plan_limit'::text; end if;
  if to_regclass('public.desistencias_user_id_unico') is null then falhas := falhas || 'falta o índice único de desistencias (EQZ-58)'::text; end if;
  if to_regclass('public.stripe_events') is null then falhas := falhas || 'falta a tabela stripe_events (EQZ-59)'::text; end if;
  if not exists (select 1 from pg_proc where proname = 'accept_workspace_invite' and pronargs = 1) then
    falhas := falhas || 'falta accept_workspace_invite(p_workspace_id) (EQZ-56)'::text;
  end if;
  itens := itens + 1;

  -- Pares (dono ativo, convidado só pendente) para a simulação abaixo, lidos antes de trocar de papel
  select coalesce(jsonb_agg(jsonb_build_object('dono', o.user_id, 'convidado', m.user_id)), '[]') into pares
    from (select distinct on (m.user_id) m.user_id, m.workspace_id from public.workspace_members m where m.status = 'pendente') m
    join public.workspace_members o on o.workspace_id = m.workspace_id and o.status = 'ativo' and o.role in ('owner', 'admin')
   where not exists (select 1 from public.workspace_members a join public.workspace_members b on b.workspace_id = a.workspace_id
                      where a.user_id = o.user_id and a.status = 'ativo' and b.user_id = m.user_id and b.status = 'ativo')
   limit 20;

  -- 7) Simulação como visitante (anon): não lista o Storage
  set local role anon;
  select count(*) into n from storage.objects where bucket_id in ('product-images', 'profile-images');
  if n > 0 then falhas := falhas || format('anon lista %s arquivos do Storage', n); end if;
  itens := itens + 1;

  -- 8) Simulação como dono: convidado pendente não aparece em profiles (EQZ-54)
  set local role authenticated;
  for par in select * from jsonb_to_recordset(pares) as x(dono uuid, convidado uuid) loop
    perform set_config('request.jwt.claims', json_build_object('sub', par.dono, 'role', 'authenticated')::text, true);
    select count(*) into n from public.profiles where id = par.convidado;
    if n > 0 then falhas := falhas || format('dono %s vê o perfil do convidado pendente %s', par.dono, par.convidado); end if;
  end loop;
  itens := itens + 1;

  if array_length(falhas, 1) is null then
    raise exception 'CONFERENCIA OK (% itens, % pares de convite simulados)', itens, jsonb_array_length(pares);
  end if;
  raise exception 'CONFERENCIA FALHOU: %', array_to_string(falhas, ' | ');
end
$conferencia$;
