-- ================================================================
-- TAREFAS — lembretes (despertador) vinculados a um lead, com aviso
-- automático na Central de Alertas (sino) quando vencem.
-- Seguro: só CRIA uma tabela nova. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.tarefas (
  id         bigint generated always as identity primary key,
  conta_id   bigint not null references public.contas(id) on delete cascade,
  lead_ref   text not null default '',
  atendente  text not null default '',   -- responsável pela tarefa (dono do lembrete)
  titulo     text not null default '',
  vencimento timestamptz not null,
  concluida  boolean not null default false,
  alertada   boolean not null default false,  -- já gerou o alerta no sino? (evita duplicar)
  criado_por text not null default '',
  criado_em  timestamptz not null default now()
);
alter table public.tarefas enable row level security;  -- sem policies: só o backend acessa
create index if not exists tarefas_lead_idx on public.tarefas (conta_id, lead_ref);
create index if not exists tarefas_vencimento_idx on public.tarefas (conta_id, concluida, alertada, vencimento);
