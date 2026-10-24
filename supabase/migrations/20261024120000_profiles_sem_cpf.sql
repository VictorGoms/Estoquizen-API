-- EQZ-54 (auditoria de 2026-10-23, achado S1): qualquer conta lia o CPF, o telefone e o nome de quem
-- ela convidasse. A policy "Membros do workspace veem perfis" incluía o convidado PENDENTE (bastava
-- convidar o e-mail) e o authenticated tinha SELECT em todas as colunas, inclusive cpf.
--
-- O front nunca lê cpf (só id, name, email, phone, avatar_*); a API lê com o service role (trial e
-- desistência). A lista de membros vem da API, que mostra só o e-mail de um convite pendente.

-- O cliente lê só as colunas que as telas usam; cpf fica só para o service role
revoke select on public.profiles from anon, authenticated;
grant  select (id, name, email, phone, avatar_color, avatar_url, created_at, updated_at)
  on public.profiles to authenticated;

-- Colegas: só quem está ATIVO num workspace meu (convite pendente não revela o perfil)
alter policy "Membros do workspace veem perfis" on public.profiles
  using (
    id = auth.uid()
    or id in (
      select m.user_id
        from public.workspace_members m
       where m.status = 'ativo'
         and m.workspace_id in (select public.my_workspace_ids())
    )
  );
