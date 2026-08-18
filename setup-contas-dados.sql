-- ================================================================
-- CONTAS: dados cadastrais (pessoa física/jurídica) + exclusão suave.
-- Usado pelo Painel Master pra criar/editar contas com dados completos
-- (CPF/CNPJ, endereço, telefone) e "excluir" sem perder o histórico
-- (soft delete: status vira 'excluida' — os dados continuam no banco).
-- Idempotente — seguro rodar mais de uma vez.
-- ================================================================

alter table public.contas add column if not exists tipo_pessoa text;   -- 'fisica' | 'juridica'
alter table public.contas add column if not exists documento text;     -- CPF ou CNPJ
alter table public.contas add column if not exists telefone text;
alter table public.contas add column if not exists cep text;
alter table public.contas add column if not exists endereco text;      -- rua e número
alter table public.contas add column if not exists bairro text;
alter table public.contas add column if not exists cidade text;
alter table public.contas add column if not exists uf text;

alter table public.contas drop constraint if exists contas_tipo_pessoa_check;
alter table public.contas add constraint contas_tipo_pessoa_check
  check (tipo_pessoa is null or tipo_pessoa in ('fisica', 'juridica'));

-- status agora tem um 3º valor possível ('excluida' = exclusão suave pelo painel master)
alter table public.contas drop constraint if exists contas_status_check;
alter table public.contas add constraint contas_status_check
  check (status in ('ativa', 'suspensa', 'excluida'));
