-- ================================================================
-- CORREÇÃO do setup.sql original — colunas e tabela que o código
-- usa mas o script do autor esqueceu de criar.
-- Seguro: só ADICIONA colunas/tabela novas; não altera nem apaga nada.
-- Pode rodar mais de uma vez sem problema (if not exists em tudo).
-- ================================================================

-- Rastreamento de origem do lead (anúncios/UTM) — usado pelo save-lead e pelo painel
alter table public.diag_instagram_leads add column if not exists utm_source   text not null default '';
alter table public.diag_instagram_leads add column if not exists utm_medium   text not null default '';
alter table public.diag_instagram_leads add column if not exists utm_campaign text not null default '';
alter table public.diag_instagram_leads add column if not exists utm_content  text not null default '';
alter table public.diag_instagram_leads add column if not exists utm_term     text not null default '';
alter table public.diag_instagram_leads add column if not exists fbclid       text not null default '';
alter table public.diag_instagram_leads add column if not exists referrer     text not null default '';

-- Controle de avisos automáticos (webhooks) — evita erro nas funções de notificação
alter table public.diag_instagram_leads add column if not exists closer_webhook_sent_at timestamptz;
alter table public.diag_instagram_leads add column if not exists closer_agendou_sent_at timestamptz;
alter table public.diag_instagram_leads add column if not exists raiox_webhook_sent_at  timestamptz;

-- Tabela de configuração do painel administrativo (chave/valor)
create table if not exists public.funnel_config (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

-- RLS ligado SEM policies para anon: só o backend (service_role) lê/escreve
alter table public.funnel_config enable row level security;
