-- ================================================================
-- KANBAN v2 — cor personalizada no cabeçalho de cada coluna.
-- Seguro: só ADICIONA uma coluna. Pode rodar mais de 1x.
-- ================================================================

alter table public.kanban_cols add column if not exists cor text not null default '';
