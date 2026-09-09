-- ================================================================
-- KANBAN GERAL — visão fixa, só leitura, que junta as colunas de
-- TODOS os quadros num único lugar. Colunas oficiais do funil sempre
-- aparecem nela; colunas personalizadas só se marcadas (mostrar_geral).
-- Seguro: só ADICIONA uma coluna nova, com padrão true (não esconde
-- nada que já existia). Pode rodar mais de 1x.
-- ================================================================

alter table public.kanban_cols
  add column if not exists mostrar_geral boolean not null default true;
