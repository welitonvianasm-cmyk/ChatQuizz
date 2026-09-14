-- ================================================================
-- RESPOSTAS RÁPIDAS — snippets de texto pronto pro atendente usar nas
-- Conversas (digita "/atalho" e completa sozinho). Seguro: só CRIA uma
-- tabela nova. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.respostas_rapidas (
  id        bigint generated always as identity primary key,
  conta_id  bigint not null references public.contas(id) on delete cascade,
  atalho    text not null default '',   -- sem "/", minúsculo, sem espaço (usa hífen)
  titulo    text not null default '',
  conteudo  text not null default '',
  criado_em timestamptz not null default now()
);
alter table public.respostas_rapidas enable row level security;
create unique index if not exists respostas_rapidas_atalho_idx on public.respostas_rapidas (conta_id, atalho);
