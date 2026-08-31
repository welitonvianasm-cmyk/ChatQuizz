-- ================================================================
-- PAUSA DO AGENTE IA POR CONVERSA (Fase 3) — quando um humano assume
-- uma conversa, o agente para de responder esse lead até ser reativado.
-- Seguro: só cria tabela nova. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.wa_conversas_estado (
  conta_id      bigint not null references public.contas(id) on delete cascade,
  telefone      text not null,
  ia_pausada    boolean not null default false,
  pausada_em    timestamptz,
  pausada_por   text not null default '',
  atualizado_em timestamptz not null default now(),
  primary key (conta_id, telefone)
);
alter table public.wa_conversas_estado enable row level security;
