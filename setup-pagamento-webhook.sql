-- ================================================================
-- WEBHOOK DE PAGAMENTO (integração via MAKE) — "de-para" de nome de
-- produto: quando o pagamento chega com um nome que não bate com
-- nenhum produto do catálogo, fica pendente (aparece em "Produtos sem
-- vínculo") até a equipe vincular uma vez; da próxima vez que esse
-- nome externo chegar, já resolve sozinho.
-- Seguro: só CRIA uma tabela nova. Pode rodar mais de uma vez.
-- ================================================================

create table if not exists public.produto_aliases (
  id           bigserial primary key,
  conta_id     bigint not null,
  nome_externo text not null,
  produto_id   bigint not null references public.produtos(id) on delete cascade,
  criado_em    timestamptz not null default now(),
  unique (conta_id, nome_externo)
);
alter table public.produto_aliases enable row level security;  -- sem policies: só o backend acessa
create index if not exists produto_aliases_conta_idx on public.produto_aliases (conta_id);
