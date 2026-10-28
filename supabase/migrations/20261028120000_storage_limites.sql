-- EQZ-64 (checklist de segurança de 2026-10-28, item "upload sem validação"): os buckets de fotos não
-- tinham limite de tamanho nem lista de tipos. O site comprime para JPG/WebP, mas quem chamasse o
-- Storage direto, com o próprio login, subia qualquer arquivo (HTML, SVG, tamanho livre) na pasta da
-- própria empresa, num bucket público.
-- APLICADO PELO JOÃO NO PAINEL em 2026-10-28 (Storage → Edit bucket); este arquivo registra o estado.
-- Rodar de novo não muda nada. Os 22 arquivos que já existiam eram todos imagem, o maior com 2,6 MB.
update storage.buckets
   set file_size_limit    = 5242880,                                        -- 5 MB
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id in ('product-images', 'profile-images');
