-- ================================================================
-- PÓS-VENDA + PERMISSÕES v1
--   1. dash_users ganha as funções: CS (Customer Success) e ADM
--      (privilégios completos de administradora).
--   2. O lead ganha venda_json: dados da conversão (CPF/CNPJ, endereço,
--      produto, valor, formas de pagamento, responsável CS, recebimento).
--   3. Tabela de produtos (nome + valor) para o cadastro das vendas.
-- Seguro: só ADICIONA. Pode rodar mais de uma vez.
-- ================================================================

alter table public.dash_users add column if not exists funcao_cs  boolean not null default false;
alter table public.dash_users add column if not exists funcao_adm boolean not null default false;

alter table public.diag_instagram_leads add column if not exists venda_json text not null default '';

create table if not exists public.produtos (
  id        bigserial primary key,
  nome      text not null,
  valor     numeric not null default 0,
  criado_em timestamptz not null default now()
);
alter table public.produtos enable row level security;
