-- ================================================================
-- GATILHOS — reformulação de Automações: em vez de gatilho fixo
-- codificado, o usuário cria gatilhos próprios (agendado/tag/
-- qualificador) e reusa em quantas Automações quiser. Seguro: só
-- CRIA tabela nova e ADICIONA colunas. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.gatilhos (
  id        bigint generated always as identity primary key,
  conta_id  bigint not null references public.contas(id) on delete cascade,
  nome      text not null default '',
  tipo      text not null,              -- 'agendado' | 'tag' | 'qualificador'
  config    text not null default '{}', -- JSON, formato depende do tipo (ver netlify/functions/gatilhos.mjs)
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.gatilhos enable row level security;
create index if not exists gatilhos_conta_idx on public.gatilhos (conta_id, ativo, tipo);

-- Automações passam a poder referenciar um gatilho reusável (em vez do
-- texto fixo em `gatilho`, que continua existindo pras automações antigas
-- — reuniao_1h/lead_vip continuam funcionando do jeito que já funcionavam).
alter table public.automacoes
  add column if not exists gatilho_id bigint references public.gatilhos(id) on delete set null,
  add column if not exists publico text not null default '{}';  -- JSON {tipo:'todos'|'qualificador'|'etiqueta', valor} — só usado quando o gatilho é do tipo 'agendado'

-- Controla a última vez que um gatilho 'agendado' recorrente disparou,
-- pra não repetir no mesmo dia/janela quando o cron roda de novo.
alter table public.gatilhos
  add column if not exists disparado_em timestamptz;

-- Prepara o terreno pra API Oficial do WhatsApp (Meta) no futuro — cada
-- número passa a declarar qual canal usa; hoje todos continuam 'evolution'.
alter table public.wa_instancias
  add column if not exists canal text not null default 'evolution';
