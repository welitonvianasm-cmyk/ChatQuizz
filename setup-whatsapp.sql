-- ================================================================
-- MÓDULO WHATSAPP v1 — conversas, automações e disparos.
--   1. wa_mensagens: histórico de cada conversa (entrada/saída).
--   2. automacoes: mensagens automáticas editáveis (nunca fixas no código).
--   3. disparos: fila de envios (manuais agendados + lembretes de reunião),
--      com chave única que impede lembrete duplicado por reunião/lead.
-- Seguro: só ADICIONA. Pode rodar mais de uma vez.
-- ================================================================

create table if not exists public.wa_mensagens (
  id        bigserial primary key,
  telefone  text not null,
  lead_ref  text not null default '',
  direcao   text not null default 'in',    -- in = recebida | out = enviada
  texto     text not null default '',
  quem      text not null default '',      -- usuária do painel que enviou
  wa_id     text not null default '',      -- id da mensagem na Evolution (anti-duplicada)
  lida      boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists wa_msg_tel on public.wa_mensagens (telefone, criado_em desc);
create unique index if not exists wa_msg_waid on public.wa_mensagens (wa_id) where wa_id <> '';
alter table public.wa_mensagens enable row level security;

create table if not exists public.automacoes (
  id        bigserial primary key,
  nome      text not null,
  gatilho   text not null default 'manual',   -- reuniao_1h | manual
  mensagem  text not null default '',
  ativa     boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.automacoes enable row level security;

create table if not exists public.disparos (
  id          bigserial primary key,
  telefone    text not null default '',
  lead_ref    text not null default '',
  nome        text not null default '',
  mensagem    text not null default '',
  enviar_em   timestamptz not null,
  status      text not null default 'pendente',  -- pendente | enviado | falhou
  erro        text not null default '',
  origem      text not null default 'manual',    -- manual | reuniao_1h
  chave_unica text not null default '',          -- lembrete: lead+reunião (anti-duplicado)
  enviado_em  timestamptz,
  criado_em   timestamptz not null default now()
);
create unique index if not exists disparos_chave on public.disparos (chave_unica) where chave_unica <> '';
alter table public.disparos enable row level security;
