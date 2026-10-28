-- Lançamento grátis até 05/01/2027 (decisão do João em 2026-10-28; src/lib/trial.ts). Os testes em andamento
-- passam a ir até 06/01/2027 00:00 em Brasília (03:00 UTC), como os cadastros novos. Só estende, nunca encurta.
-- As marcas dos e-mails da reta final (resumo e último dia) voltam a vazio, para saírem perto da data nova.
update public.subscriptions
   set trial_ends_at          = '2027-01-06T03:00:00Z',
       trial_recap_sent_at    = null,
       trial_last_day_sent_at = null
 where status = 'trialing'
   and trial_ends_at < '2027-01-06T03:00:00Z';
