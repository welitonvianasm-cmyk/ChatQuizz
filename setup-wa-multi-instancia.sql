-- ================================================================
-- WHATSAPP MULTI-INSTÂNCIA — cada conta conecta seu(s) próprio(s)
-- número(s) via Evolution API, em vez de um número global compartilhado
-- por todas as contas (como era até aqui).
-- Seguro: só cria tabela nova e adiciona coluna. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.wa_instancias (
  id             bigint generated always as identity primary key,
  conta_id       bigint not null references public.contas(id) on delete cascade,
  nome_instancia text not null,             -- nome único na Evolution (global no servidor): c{conta_id}-{slug}
  rotulo         text not null default '',  -- nome amigável escolhido pela conta ("Vendas", "Suporte")
  numero         text not null default '',  -- número E.164 detectado após conectar (só exibição)
  padrao         boolean not null default false,  -- instância padrão da conta
  estado         text not null default 'desconectada', -- cache local; fonte de verdade real é a Evolution
  criado_em      timestamptz not null default now()
);
create unique index if not exists wa_instancias_nome_idx on public.wa_instancias (nome_instancia);
create index if not exists wa_instancias_conta_idx on public.wa_instancias (conta_id);
alter table public.wa_instancias enable row level security;  -- sem policies: só o backend (service_role) acessa

-- registra por qual instância cada mensagem entrou/saiu (resolve o tenant
-- pelo nome da instância no webhook, e evita responder pelo número errado
-- numa conta com vários números conectados)
alter table public.wa_mensagens add column if not exists instancia text not null default '';

-- ================================================================
-- PASSO MANUAL, depois de rodar o SQL acima: já existe 1 número
-- conectado em produção hoje (a antiga EVOLUTION_INSTANCE global).
-- Sem esse insert, essa conta fica sem nenhuma instância cadastrada e
-- para de conseguir mandar/receber mensagem até você conectar de novo
-- pelo painel. Troque os dois valores abaixo e rode separadamente:
--
-- insert into public.wa_instancias (conta_id, nome_instancia, rotulo, padrao)
-- values (<CONTA_ID_ATUAL>, '<NOME_DA_EVOLUTION_INSTANCE_ATUAL>', 'Principal', true);
-- ================================================================
