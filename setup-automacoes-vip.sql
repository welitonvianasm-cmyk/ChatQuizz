-- ================================================================
-- ALERTA DE LEAD PRIORITÁRIO (gatilho de automação "lead_vip") —
-- dispara uma mensagem pro WhatsApp da equipe (destino) quando um lead
-- completa o quiz com o qualificador marcado como prioritário
-- (qualificador_alvo). Seguro: só ADICIONA colunas. Pode rodar mais de 1x.
-- ================================================================

alter table public.automacoes add column if not exists destino text not null default '';
alter table public.automacoes add column if not exists qualificador_alvo text not null default '';
alter table public.diag_instagram_leads add column if not exists alerta_vip_enviado boolean not null default false;
