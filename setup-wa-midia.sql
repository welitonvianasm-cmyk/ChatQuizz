-- ================================================================
-- MÍDIA NO WHATSAPP — guarda a foto/áudio/vídeo/documento recebido ou
-- enviado direto na linha da mensagem (base64), mesmo padrão já usado
-- pro QR Code. Seguro: só ADICIONA uma coluna nova. Pode rodar mais de 1x.
-- ================================================================

alter table public.wa_mensagens
  add column if not exists midia_base64 text;
