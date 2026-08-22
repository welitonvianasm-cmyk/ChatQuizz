-- ================================================================
-- AGENDAMENTO AUTOMÁTICO × MANUAL — de onde veio a confirmação da
-- reunião: 'auto' (lead agendou sozinho pelo embed do Cal.com dentro
-- do próprio quiz) ou 'manual' (equipe marcou/remarcou pelo painel).
-- Seguro: só ADICIONA coluna. Pode rodar mais de 1x.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists agendamento_origem text not null default '';
