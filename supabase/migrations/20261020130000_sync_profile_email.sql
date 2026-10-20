-- Troca de e-mail pelo Perfil (pedido do João em 2026-10-20). O Supabase Auth troca auth.users.email
-- depois que a pessoa confirma pelo link; a cópia em profiles.email (lista de membros, convite que
-- procura quem já tem conta) acompanha. Antes ela só era gravada no cadastro (handle_new_user).

create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

revoke execute on function public.handle_user_email_change() from public, anon, authenticated;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();
