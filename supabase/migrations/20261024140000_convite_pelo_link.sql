-- EQZ-56 (auditoria de 2026-10-23, achado S3): o aceite pelo /set-password usava o workspace_id do
-- user_metadata, e o convite de outra empresa para a mesma conta (ainda não confirmada) reescreve esse
-- metadata. A pessoa abria o e-mail da empresa certa e entrava na do atacante. Agora o link do convite
-- leva o workspace_id e a função aceita só o convite pendente desse workspace.
-- A versão sem parâmetro continua até os links antigos expirarem (migração 20261025120000).
create or replace function public.accept_workspace_invite(p_workspace_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.workspace_members
     set status = 'ativo'
   where user_id      = v_user_id
     and workspace_id = p_workspace_id
     and status       = 'pendente';

  if not found then
    -- Aceitar de novo um convite já aceito não é erro
    if exists (
      select 1 from public.workspace_members
       where user_id = v_user_id and workspace_id = p_workspace_id and status = 'ativo'
    ) then
      return json_build_object('success', true, 'workspace_id', p_workspace_id);
    end if;
    raise exception 'Nenhum convite encontrado para este usuário';
  end if;

  return json_build_object('success', true, 'workspace_id', p_workspace_id);
end;
$$;

revoke execute on function public.accept_workspace_invite(uuid) from public, anon;
grant  execute on function public.accept_workspace_invite(uuid) to authenticated;

-- Só a própria pessoa tira o convite dela de "pendente" (aceitando). A policy "Admin/Owner gerencia
-- membros" com o GRANT de update(status) deixava um admin ativar o convidado sem ele aceitar.
-- A API (service role: POST /members/accept, reenvio de convite) não tem auth.uid() e passa direto.
create or replace function public.protect_invite_acceptance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if old.status = 'pendente' and new.status <> 'pendente' and old.user_id <> auth.uid() then
    raise exception 'Só a pessoa convidada pode aceitar o convite.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_invite_acceptance() from public, anon, authenticated;

create trigger protect_invite_acceptance
  before update of status on public.workspace_members
  for each row execute function public.protect_invite_acceptance();
