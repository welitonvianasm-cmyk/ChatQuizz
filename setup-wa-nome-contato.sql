-- ================================================================
-- NOME DO CONTATO (pushName do WhatsApp) — guardado a cada mensagem
-- recebida, pra mostrar na lista de Conversas quando o telefone ainda
-- não bateu com nenhum lead cadastrado. Seguro: só adiciona coluna.
-- Pode rodar mais de 1x.
-- ================================================================

alter table public.wa_mensagens add column if not exists push_name text not null default '';
