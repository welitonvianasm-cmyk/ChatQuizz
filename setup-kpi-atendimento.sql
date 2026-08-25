-- ================================================================
-- KPIs DE ATENDIMENTO — "Tempo até 1º atendimento" e "Leads Atendidos"
-- precisam de um timestamp gravado só na 1ª vez (nunca sobrescrito depois),
-- na primeira mensagem real de WhatsApp OU na primeira atribuição de
-- atendente, o que vier primeiro. "Tipo de resposta WhatsApp" precisa
-- saber se a mensagem foi texto/áudio/mídia/figurinha.
-- Seguro: só ADICIONA colunas. Pode rodar mais de uma vez.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists primeiro_atendimento_em timestamptz;
alter table public.diag_instagram_leads add column if not exists primeiro_atendimento_fonte text not null default '';
alter table public.wa_mensagens add column if not exists tipo text not null default 'texto';
