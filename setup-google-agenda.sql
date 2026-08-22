-- ================================================================
-- GOOGLE AGENDA — espelho de eventos (não substitui o Cal.com, que
-- continua sendo a "vitrine" de agendamento do lead; o Google Agenda
-- só recebe uma cópia de cada reunião confirmada, com Meet automático).
-- Guarda o id do evento espelho no Google, pra saber se deve criar um
-- evento novo ou atualizar o existente numa remarcação.
-- Seguro: só ADICIONA coluna. Pode rodar mais de 1x.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists google_event_id text not null default '';
