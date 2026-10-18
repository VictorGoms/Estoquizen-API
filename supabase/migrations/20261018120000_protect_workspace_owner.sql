-- SCRUM-49: a policy "Admin/Owner gerencia membros" (ALL em workspace_members) deixa um admin
-- rebaixar, inativar ou remover o owner e se promover a owner. O front altera workspace_members
-- direto pelo Supabase, então a regra precisa ficar no banco, valendo para qualquer caminho.
--
-- Regras (só para usuários logados; service_role e cascatas do auth passam direto):
--   - só owner promove alguém a owner, rebaixa, altera ou remove outro owner;
--   - o workspace nunca fica sem pelo menos um owner ativo;
--   - recusar ou aceitar o próprio convite continua permitido.
create or replace function public.protect_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_is_last_owner boolean;
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;

  select role into v_actor_role
    from workspace_members
   where workspace_id = old.workspace_id and user_id = v_actor and status = 'ativo';

  v_is_last_owner := old.role = 'owner' and old.status = 'ativo' and not exists (
    select 1 from workspace_members
     where workspace_id = old.workspace_id and role = 'owner' and status = 'ativo' and id <> old.id
  );

  if tg_op = 'DELETE' then
    if old.role = 'owner' and old.user_id <> v_actor and coalesce(v_actor_role, '') <> 'owner' then
      raise exception 'Só o dono pode remover outro dono do workspace.' using errcode = '42501';
    end if;
    if v_is_last_owner then
      raise exception 'O workspace precisa de pelo menos um dono ativo.' using errcode = '42501';
    end if;
    return old;
  end if;

  if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id then
    raise exception 'Não é possível mover um membro para outro workspace.' using errcode = '42501';
  end if;

  if coalesce(v_actor_role, '') <> 'owner' then
    if new.role = 'owner' and old.role <> 'owner' then
      raise exception 'Só o dono pode promover alguém a dono.' using errcode = '42501';
    end if;
    if old.role = 'owner' and old.user_id <> v_actor then
      raise exception 'Só o dono pode alterar outro dono.' using errcode = '42501';
    end if;
  end if;

  if v_is_last_owner and (new.role <> 'owner' or new.status <> 'ativo') then
    raise exception 'O workspace precisa de pelo menos um dono ativo.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.protect_workspace_owner() from public, anon, authenticated;

create trigger protect_workspace_owner
  before update or delete on public.workspace_members
  for each row execute function public.protect_workspace_owner();
