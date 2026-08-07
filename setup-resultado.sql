-- ================================================================
-- LEADS CONVERTIDOS E PERDIDOS — desfecho do lead com data,
-- responsável e motivo (auditoria completa).
-- Seguro: só ADICIONA colunas. Pode rodar mais de 1x.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists resultado text not null default '';
-- resultado: '' = ativo | convertido | perdido
alter table public.diag_instagram_leads add column if not exists resultado_motivo text not null default '';
alter table public.diag_instagram_leads add column if not exists resultado_em timestamptz;
alter table public.diag_instagram_leads add column if not exists resultado_por text not null default '';
