-- ================================================================
-- ETIQUETAS — tags livres pra marcar leads (N:N de verdade, catálogo
-- por conta + tabela de junção com o lead). Seguro: só CRIA tabelas
-- novas. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.etiquetas (
  id        bigint generated always as identity primary key,
  conta_id  bigint not null references public.contas(id) on delete cascade,
  nome      text not null default '',
  cor       text not null default '#22A55E',
  ordem     int not null default 0,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.etiquetas enable row level security;
create index if not exists etiquetas_conta_idx on public.etiquetas (conta_id, ativo);

create table if not exists public.lead_etiquetas (
  conta_id    bigint not null references public.contas(id) on delete cascade,
  lead_ref    text not null,
  etiqueta_id bigint not null references public.etiquetas(id) on delete cascade,
  criado_em   timestamptz not null default now(),
  primary key (lead_ref, etiqueta_id)
);
alter table public.lead_etiquetas enable row level security;
create index if not exists lead_etiquetas_conta_idx on public.lead_etiquetas (conta_id, lead_ref);
create index if not exists lead_etiquetas_etiqueta_idx on public.lead_etiquetas (etiqueta_id);
