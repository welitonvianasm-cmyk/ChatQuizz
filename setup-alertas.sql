-- ================================================================
-- CENTRAL DE ALERTAS — notificações internas do CRM (sino + popup).
-- Seguro: só CRIA uma tabela nova. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.alertas (
  id        bigint generated always as identity primary key,
  lead_ref  text not null default '',
  lead_nome text not null default '',
  atendente text not null default '',   -- destinatário do alerta (nome do atendente)
  tipo      text not null default 'presenca',
  descricao text not null default '',
  data_hora timestamptz,                -- data/hora do evento (ex: da reunião)
  status    text not null default 'pendente',  -- pendente | lido
  criado_em timestamptz not null default now()
);
alter table public.alertas enable row level security;  -- sem policies: só o backend acessa
create index if not exists alertas_dest_idx on public.alertas (atendente, status);
