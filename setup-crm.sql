-- ================================================================
-- CRM SUAVIS — Fases 1-3: atendente + status do agendamento + Kanban
-- Seguro: só ADICIONA colunas/tabelas novas. Pode rodar mais de 1x.
-- ================================================================

-- Fase 1: atendente responsável e status do agendamento no lead
alter table public.diag_instagram_leads add column if not exists atendente text not null default '';
alter table public.diag_instagram_leads add column if not exists agendamento_status text not null default '';
-- agendamento_status: '' = confirmado | concluido | reagendado | cancelado

-- Fase 3: Quadros Kanban (funis ilimitados)
create table if not exists public.kanban_boards (
  id        bigint generated always as identity primary key,
  nome      text not null,
  criado_em timestamptz not null default now()
);
create table if not exists public.kanban_cols (
  id       bigint generated always as identity primary key,
  board_id bigint not null,
  nome     text not null,
  ordem    int not null default 0
);
create table if not exists public.kanban_cards (
  id        bigint generated always as identity primary key,
  board_id  bigint not null,
  col_id    bigint not null,
  lead_ref  text not null,
  ordem     bigint not null default 0,
  criado_em timestamptz not null default now()
);
alter table public.kanban_boards enable row level security;
alter table public.kanban_cols   enable row level security;
alter table public.kanban_cards  enable row level security;
create index if not exists kanban_cols_board_idx  on public.kanban_cols (board_id);
create index if not exists kanban_cards_board_idx on public.kanban_cards (board_id);
