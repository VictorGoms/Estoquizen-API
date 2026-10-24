-- EQZ-58 (auditoria de 2026-10-23, achado S6): a regra "desistência pelo app 1 vez por pessoa" conferia
-- a tabela e só gravava no fim, depois de estornar e cancelar. Dois pedidos ao mesmo tempo (duas
-- empresas pagas da mesma pessoa) passavam juntos pela conferência. Agora a API grava a reserva ANTES
-- de estornar e os índices únicos fazem o segundo pedido falhar (23505 → 409, pelo contato@).
-- A tabela estava vazia em 2026-10-23. Os índices simples de antes ficam (sem DROP: o MCP recusa).
create unique index if not exists desistencias_user_id_unico  on public.desistencias (user_id);
create unique index if not exists desistencias_cpf_hash_unico on public.desistencias (cpf_hash) where cpf_hash is not null;
