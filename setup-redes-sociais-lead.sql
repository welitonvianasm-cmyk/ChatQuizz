-- ================================================================
-- REDES SOCIAIS DO LEAD — TikTok e Facebook (Instagram já existia,
-- coluna legada do produto antigo "diagnóstico de Instagram", nunca
-- preenchida pelo quiz atual). Editáveis no Cartão do Lead ("Editar")
-- e/ou preenchidas automaticamente se o quiz tiver uma pergunta com o
-- nome da rede. Seguro: só adiciona coluna. Pode rodar mais de 1x.
-- ================================================================

alter table public.diag_instagram_leads add column if not exists tiktok text not null default '';
alter table public.diag_instagram_leads add column if not exists facebook text not null default '';
