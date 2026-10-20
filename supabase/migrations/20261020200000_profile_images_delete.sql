-- Fotos de perfil: cada troca agora grava um arquivo novo (o CDN do Supabase ignora "?t=" e servia a
-- foto antiga no mesmo caminho) e o front apaga a anterior. Faltava a regra de DELETE no bucket;
-- cada pessoa só apaga o que está na própria pasta, igual às regras de INSERT e UPDATE.

create policy "Usuarios apagam proprio avatar" on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-images'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );
