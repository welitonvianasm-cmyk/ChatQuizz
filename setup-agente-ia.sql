-- ================================================================
-- AGENTE IA — configuração, base de conhecimento, perguntas-e-respostas
-- e arquivos do painel de treinamento (Fase 2 do Agente de IA).
-- Seguro: só cria tabela nova / adiciona coluna. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.agentes_ia (
  id                      bigint generated always as identity primary key,
  conta_id                bigint not null unique references public.contas(id) on delete cascade,
  ativo                   boolean not null default false,
  nome                    text not null default 'Assistente',
  cargo                   text not null default '',
  persona                 text not null default '',
  conhecimento            text not null default '',
  instancia_id            bigint references public.wa_instancias(id) on delete set null,
  estrategia_agenda       text not null default 'nenhuma',   -- nenhuma | google_direto | link_externo
  link_agendamento        text not null default '',
  duracao_reuniao_min     int not null default 30,
  mensagem_escalonamento  text not null default '',
  atualizado_em           timestamptz not null default now(),
  criado_em               timestamptz not null default now()
);
alter table public.agentes_ia enable row level security;

create table if not exists public.agente_qa (
  id        bigint generated always as identity primary key,
  conta_id  bigint not null references public.contas(id) on delete cascade,
  pergunta  text not null,
  resposta  text not null,
  ativo     boolean not null default true,
  ordem     int not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists agente_qa_conta_idx on public.agente_qa (conta_id);
alter table public.agente_qa enable row level security;

create table if not exists public.agente_arquivos (
  id            bigint generated always as identity primary key,
  conta_id      bigint not null references public.contas(id) on delete cascade,
  nome          text not null,
  tipo_arquivo  text not null default 'documento',  -- imagem | documento
  mimetype      text not null default '',
  storage_path  text not null,
  tamanho_bytes bigint not null default 0,
  quando_enviar text not null default '',   -- descrição em linguagem natural: QUANDO enviar (entra no prompt)
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);
create index if not exists agente_arquivos_conta_idx on public.agente_arquivos (conta_id);
alter table public.agente_arquivos enable row level security;

-- produtos ganha campos de roteamento pro agente (mesma entidade do Pós-Venda, só estende)
alter table public.produtos add column if not exists descricao text not null default '';
alter table public.produtos add column if not exists link_destino text not null default '';
alter table public.produtos add column if not exists instrucoes_agente text not null default '';

-- bucket privado do Supabase Storage (service_role only, nunca público)
insert into storage.buckets (id, name, public)
values ('agente-arquivos', 'agente-arquivos', false)
on conflict (id) do nothing;
