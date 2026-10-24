-- EQZ-58 (auditoria de 2026-10-23, achado S5): com a chave pública do site, qualquer pessoa sem login
-- listava o Storage inteiro: todas as fotos de produto de todas as empresas (e os ids dos workspaces,
-- que são os nomes das pastas) e todos os avatares (pastas = ids de usuário).
--
-- Os dois buckets são públicos: cada arquivo continua abrindo pela URL pública, sem policy nenhuma.
-- O SELECT em storage.objects só serve para listar e para o upload com upsert (o cadastro de produto
-- usa), então fica restrito a quem é dono da pasta.
alter policy "Imagens são públicas" on storage.objects
  to authenticated
  using (bucket_id = 'product-images'
         and (storage.foldername(name))[1] in (select public.my_workspace_ids()::text));

alter policy "Avatars sao publicos" on storage.objects
  to authenticated
  using (bucket_id = 'profile-images'
         and (storage.foldername(name))[1] = auth.uid()::text);
