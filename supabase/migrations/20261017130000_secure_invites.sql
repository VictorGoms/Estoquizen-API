-- SCRUM-42: accept_workspace_invite() lia workspace_id e role de auth.users.raw_user_meta_data,
-- que o próprio usuário edita com supabase.auth.updateUser({ data }), e fazia INSERT ... ON CONFLICT.
-- Qualquer conta virava owner de qualquer workspace cujo id conhecesse (reproduzido em 2026-10-16).
--
-- Agora a função só ativa um convite PENDENTE que já existe em workspace_members (criado pela API,
-- que exige owner/admin). O papel vem da linha do convite; o metadata serve só para escolher qual
-- convite aceitar. Mesma assinatura, então /set-password continua igual.
create or replace function public.accept_workspace_invite()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select (raw_user_meta_data->>'workspace_id')::uuid
    into v_workspace_id
    from auth.users
   where id = v_user_id;

  if v_workspace_id is null then
    raise exception 'Nenhum convite encontrado para este usuário';
  end if;

  update public.workspace_members
     set status = 'ativo'
   where user_id      = v_user_id
     and workspace_id = v_workspace_id
     and status       = 'pendente';

  if not found then
    -- Aceitar de novo um convite já aceito não é erro
    if exists (
      select 1 from public.workspace_members
       where user_id = v_user_id and workspace_id = v_workspace_id and status = 'ativo'
    ) then
      return json_build_object('success', true, 'workspace_id', v_workspace_id);
    end if;
    raise exception 'Nenhum convite encontrado para este usuário';
  end if;

  return json_build_object('success', true, 'workspace_id', v_workspace_id);
end;
$$;

revoke execute on function public.accept_workspace_invite() from public, anon;
grant  execute on function public.accept_workspace_invite() to authenticated;

-- SCRUM-43: RPC antiga, substituída por POST /members/invite e não usada pelo front. Continuava
-- executável por anon/authenticated e adicionava o usuário direto como ATIVO, com qualquer papel
-- (inclusive owner), sem limite de plano, limite diário nem checagem de assinatura.
drop function if exists public.invite_member(uuid, text, text);
