-- ================================================================
-- CONTAS: domínio próprio por assinante.
-- O assinante cadastra o domínio dele em Configurações → Conexões
-- ('pendente'); o painel master ativa ('ativo') depois de conferir o
-- DNS e adicionar o domínio manualmente em Netlify → Domain management.
-- Enquanto não tiver um domínio próprio ativo, o quiz da conta continua
-- no endereço padrão da plataforma (com subdomínio, quando configurado).
-- Idempotente — seguro rodar mais de uma vez.
-- ================================================================

alter table public.contas add column if not exists dominio_proprio text;
alter table public.contas add column if not exists dominio_status text;  -- 'pendente' | 'ativo'

create unique index if not exists contas_dominio_proprio_idx
  on public.contas (dominio_proprio) where dominio_proprio is not null;

alter table public.contas drop constraint if exists contas_dominio_status_check;
alter table public.contas add constraint contas_dominio_status_check
  check (dominio_status is null or dominio_status in ('pendente', 'ativo'));
