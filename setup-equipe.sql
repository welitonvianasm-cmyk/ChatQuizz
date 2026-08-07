-- ================================================================
-- EQUIPE DO PAINEL (v2) — usuários com senha PRÓPRIA (criptografada,
-- invisível até para a administradora) + livro de registros (log).
-- Seguro: só cria/ajusta as tabelas da equipe. Pode rodar mais de 1x.
-- ================================================================

create table if not exists public.dash_users (
  id           bigint generated always as identity primary key,
  nome         text not null,
  email        text not null unique,
  celular      text not null default '',
  validade     date,                          -- vazio = sem prazo; passou = acesso cortado
  senha_hash   text unique,                   -- senha criptografada (ninguém consegue ler)
  trocar_senha boolean not null default true, -- true = precisa definir a própria senha no 1º acesso
  criado_em    timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- ajustes p/ quem já tinha a versão 1 da tabela
alter table public.dash_users add column if not exists senha_hash text;
alter table public.dash_users add column if not exists trocar_senha boolean not null default true;
alter table public.dash_users drop column if exists senha;
create unique index if not exists dash_users_hash_idx on public.dash_users (senha_hash);
alter table public.dash_users enable row level security;  -- sem policies: só o backend acessa

create table if not exists public.dash_logs (
  id        bigint generated always as identity primary key,
  tipo      text not null,        -- 'acesso' | 'exportou_relatorio' | 'definiu_senha'
  nome      text not null default '',
  email     text not null default '',
  celular   text not null default '',
  validade  date,
  criado_em timestamptz not null default now()   -- data e hora do evento
);
alter table public.dash_logs enable row level security;
create index if not exists dash_logs_criado_idx on public.dash_logs (criado_em desc);
