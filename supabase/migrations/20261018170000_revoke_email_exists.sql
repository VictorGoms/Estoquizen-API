-- SCRUM-65: o /forgot-password não chama mais email_exists. Aberta para anon, ela deixava
-- qualquer pessoa descobrir quem tem conta. A função fica, mas só o service_role executa.
revoke execute on function public.email_exists(text) from public, anon, authenticated;
