-- ================================================================
-- PERMISSÕES POR MÓDULO — visibilidade de menu por usuário/atendente
-- (eixo aditivo, separado de funcao_adm/funcao_cs). Seguro: só adiciona
-- coluna, com default que preserva o acesso total de quem já existe.
-- Pode rodar mais de 1x.
-- ================================================================

alter table public.usuarios add column if not exists permissoes text not null
  default '{"tudo":true,"modulos":{}}';
