-- EQZ-59 (auditoria de 2026-10-23, endurecimento): estas tabelas tinham INSERT/UPDATE/DELETE para
-- anon e authenticated pelo GRANT padrão do Supabase, e só a RLS sem policy segurava. subscriptions
-- decide o plano e o bloqueio do workspace: uma policy criada por engano a abriria para o cliente.
-- Só a API (service role) e as funções SECURITY DEFINER usam estas tabelas; o front não as lê.
revoke all on public.subscriptions    from anon, authenticated;
revoke all on public.cancel_feedback  from anon, authenticated;
revoke all on public.nfce_falhas      from anon, authenticated;
revoke all on public.nfce_diagnostico from anon, authenticated;

-- Lista de compras: membros leem pela policy; gravar só pela API
revoke insert, update, delete, truncate, references, trigger on public.shopping_list_items from authenticated;
revoke all on public.shopping_list_items from anon;

-- O visitante sem login (chave anon) não lê tabela nenhuma: as policies já não devolviam nada para ele,
-- agora nem o GRANT existe
revoke all on all tables in schema public from anon;
