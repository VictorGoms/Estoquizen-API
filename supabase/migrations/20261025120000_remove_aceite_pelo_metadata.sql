-- EQZ-56, segunda parte. APLICAR SÓ DEPOIS de o front com o aceite pelo link estar no ar há mais de
-- 24 h (o link de convite do Supabase expira antes disso): até lá, um convite enviado antes do deploy
-- ainda usa a versão sem parâmetro, que lê o workspace_id do user_metadata (desviável).
drop function if exists public.accept_workspace_invite();
