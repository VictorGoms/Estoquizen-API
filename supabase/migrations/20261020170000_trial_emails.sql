-- EQZ-05: e-mails da reta final do trial, enviados pelo job diário (src/lib/cleanup.ts):
-- resumo "o que você já fez" ~4 dias antes do fim, aviso do último dia e, depois do fim,
-- "seus dados estão guardados". Cada coluna marca o envio, para sair uma vez só.
alter table public.subscriptions
  add column if not exists trial_recap_sent_at    timestamptz,
  add column if not exists trial_last_day_sent_at timestamptz,
  add column if not exists trial_ended_sent_at    timestamptz;
