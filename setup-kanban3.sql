-- ================================================================
-- KANBAN v3 — Funil inteligente por atendente.
--   1. Cada quadro Kanban ganha um atendente responsável (vínculo).
--   2. Colunas oficiais do funil ganham um "tipo" (atribuido, conversa,
--      followup, agendado, perdido, convertido) — colunas personalizadas
--      ficam com tipo vazio.
--   3. O lead ganha a "etapa" do funil comercial (Status do CRM),
--      separada do andamento do quiz (que virou a coluna Resposta).
-- Seguro: só ADICIONA colunas. Pode rodar mais de uma vez.
-- ================================================================

alter table public.kanban_boards add column if not exists atendente text not null default '';
alter table public.kanban_boards add column if not exists descricao text not null default '';
alter table public.kanban_cols   add column if not exists tipo      text not null default '';
alter table public.diag_instagram_leads add column if not exists etapa text not null default '';
