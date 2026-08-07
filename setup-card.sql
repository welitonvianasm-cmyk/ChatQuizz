-- ================================================================
-- CARTÃO DO LEAD — anotações da equipe, campos personalizados e
-- histórico de interações (tudo num campo só, por lead).
-- Seguro: só ADICIONA uma coluna. Pode rodar mais de 1x.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists equipe_json text not null default '';
