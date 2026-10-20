-- E-mail "Assinatura confirmada" (pedido do João em 2026-10-20). O Stripe pode reenviar o
-- checkout.session.completed; a coluna guarda para qual assinatura o e-mail já saiu, para não
-- mandar de novo.
alter table public.subscriptions
  add column if not exists confirmation_email_sub_id text;

comment on column public.subscriptions.confirmation_email_sub_id is
  'Assinatura do Stripe para a qual o e-mail "Assinatura confirmada" já foi enviado.';
