-- ================================================================
-- Sistema de qualificação configurável do quiz (Qualificadores,
-- Níveis de Consciência, votação por maioria e roteamento).
-- Seguro: só ADICIONA colunas novas; não altera nem apaga nada.
-- Pode rodar mais de uma vez sem problema (if not exists em tudo).
-- ================================================================

-- Resultado da votação por maioria (calculado no servidor em save-lead)
alter table public.diag_instagram_leads add column if not exists qualificador      text not null default '';
alter table public.diag_instagram_leads add column if not exists nivel_consciencia text not null default '';

-- Respostas cruas do lead, pra poder reprocessar/auditar depois sem depender
-- só das colunas legadas (nicho/seguidores/dificuldade/faturamento)
alter table public.diag_instagram_leads add column if not exists respostas_json text not null default '';

-- Roteamento aplicado no fim do quiz (snapshot no momento da conclusão) e
-- trava de idempotência do disparo automático de WhatsApp
alter table public.diag_instagram_leads add column if not exists roteamento_tipo        text not null default '';
alter table public.diag_instagram_leads add column if not exists roteamento_disparado_em timestamptz;

-- A config completa (perguntas/qualificadores/níveis/resultados/roteamento e,
-- depois, os links de rastreio) já vive na tabela funnel_config (criada em
-- setup-fix.sql), nas chaves 'quiz_perguntas' e 'links_rastreio' — nenhuma
-- tabela nova é necessária pra isso.
