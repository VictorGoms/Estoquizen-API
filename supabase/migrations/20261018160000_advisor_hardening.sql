-- SCRUM-61: alertas do Supabase Advisor (segurança).
--
-- 1) search_path fixo: sem ele, quem cria objetos num schema do search_path consegue
--    sequestrar nomes usados por funções SECURITY DEFINER. Todas já usam nomes qualificados.
alter function public.email_exists(text)        set search_path = public;
alter function public.handle_new_user()         set search_path = public;
alter function public.my_workspace_ids()        set search_path = public;
alter function public.my_admin_workspace_ids()  set search_path = public;

-- 2) SECURITY DEFINER executáveis pela API REST:
--    - handle_new_user (trigger de auth.users) e rls_auto_enable (event trigger) não são
--      chamadas por ninguém; o EXECUTE só é checado ao criar o gatilho, não ao disparar.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
--    - my_workspace_ids / my_admin_workspace_ids são usadas nas policies de RLS, então o
--      usuário logado precisa delas; o anônimo não.
revoke execute on function public.my_workspace_ids()       from public, anon;
revoke execute on function public.my_admin_workspace_ids() from public, anon;
--    - email_exists continua para anon: a tela /forgot-password usa antes do login.
--    - accept_workspace_invite continua para authenticated (é a RPC do /set-password).
--
-- Fica no painel do Supabase (não dá por SQL): Auth → proteção contra senha vazada e
-- tamanho mínimo de senha 8.
