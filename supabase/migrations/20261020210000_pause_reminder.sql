-- EQZ-07: lembrete por e-mail de 1 a 3 dias antes de a pausa acabar (a cobrança volta nesse dia).
-- Marca o envio para sair uma vez por pausa; a API zera ao pausar de novo ou ao retomar.
alter table public.subscriptions
  add column if not exists pause_reminder_sent_at timestamptz;
