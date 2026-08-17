-- ================================================================
-- MULTI-TENANT (QuizzHub) — Fase A: fundação.
-- Cria `contas` (o "tenant"), migra `dash_users` -> `usuarios` com
-- vínculo de conta, e adiciona `conta_id` em todas as outras tabelas.
-- Migra os dados existentes pra "conta 0" (a sua conta atual).
-- Seguro: idempotente (pode rodar mais de 1x), não apaga dado nenhum.
-- ================================================================

-- 1) CONTAS (tenant) ------------------------------------------------
create table if not exists public.contas (
  id           bigint generated always as identity primary key,
  nome         text not null,
  subdominio   text unique,                    -- ex: 'clinica-bella' → clinica-bella.quizzhub.com
  email_contato text,
  plano        text not null default 'lite',   -- 'lite' | 'completo'
  status       text not null default 'ativa',  -- 'ativa' | 'suspensa'
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.contas enable row level security; -- sem policies: só o backend (service_role) acessa
alter table public.contas add column if not exists subdominio text;
create unique index if not exists contas_subdominio_idx on public.contas (subdominio) where subdominio is not null;

-- conta 0 = a sua conta atual (dados já existentes migram pra ela).
-- Renomeie o "nome"/"subdominio" quando quiser — são só rótulos.
insert into public.contas (nome, subdominio, email_contato, plano, status)
select 'Minha Conta', 'app', 'welitonviana.sm@gmail.com', 'completo', 'ativa'
where not exists (select 1 from public.contas);

-- 2) USUÁRIOS (ex dash_users) — login por e-mail+senha, ligado a uma conta
alter table if exists public.dash_users rename to usuarios;

alter table public.usuarios add column if not exists conta_id bigint references public.contas(id);
alter table public.usuarios add column if not exists eh_dono boolean not null default false;

-- índice antigo de busca-por-hash não faz mais sentido (login agora é por e-mail)
drop index if exists public.dash_users_hash_idx;

-- backfill: usuários existentes (se houver) entram na conta 0
update public.usuarios
set conta_id = (select id from public.contas order by id limit 1)
where conta_id is null;

alter table public.usuarios alter column conta_id set not null;
create index if not exists usuarios_conta_idx on public.usuarios (conta_id);

-- bootstrap: garante que a conta 0 tem um usuário dono/admin pra logar.
-- Senha temporária (troque no primeiro acesso): quizzhub-6b917e-65cd20
insert into public.usuarios (nome, email, celular, senha_hash, trocar_senha, funcao_adm, eh_dono, conta_id)
select 'Administradora', 'welitonviana.sm@gmail.com', '',
       'b490ffc033751513a9dcedcbb3ae0ca1:11c770245d5abe0f44d99874206bf7c2f2e0e0b9b60ead3eb131aac4a7de97311bc61a7eb71f8988228042c019f409fd48f17476f9f93e316465f3933208d3f5',
       true, true, true,
       (select id from public.contas order by id limit 1)
where not exists (select 1 from public.usuarios where email = 'welitonviana.sm@gmail.com');

-- usuários que já existiam antes desta migração usavam o esquema de
-- senha antigo (hash sem salt próprio) — força todo mundo a definir
-- senha nova no próximo acesso, pro novo formato (salt:hash) valer.
update public.usuarios set trocar_senha = true where senha_hash not like '%:%';

-- 3) CONTA_ID em todas as outras tabelas -----------------------------
-- (mesmo padrão pras 10 tabelas restantes: adiciona nullable, migra
-- pra conta 0, torna obrigatório, indexa)

do $$
declare
  tabela text;
  conta0 bigint;
begin
  select id into conta0 from public.contas order by id limit 1;

  foreach tabela in array array[
    'diag_instagram_leads', 'kanban_boards', 'kanban_cols', 'kanban_cards',
    'dash_logs', 'alertas', 'produtos', 'wa_mensagens', 'automacoes', 'disparos'
  ]
  loop
    if to_regclass('public.' || tabela) is not null then
      execute format('alter table public.%I add column if not exists conta_id bigint references public.contas(id)', tabela);
      execute format('update public.%I set conta_id = %L where conta_id is null', tabela, conta0);
      execute format('alter table public.%I alter column conta_id set not null', tabela);
      execute format('create index if not exists %I on public.%I (conta_id)', tabela || '_conta_idx', tabela);
    end if;
  end loop;
end $$;

-- 4) FUNNEL_CONFIG — caso especial: a chave primária hoje é só `key`
--    (colidiria entre contas). Vira composta (conta_id, key).
alter table public.funnel_config add column if not exists conta_id bigint references public.contas(id);
update public.funnel_config set conta_id = (select id from public.contas order by id limit 1) where conta_id is null;
alter table public.funnel_config alter column conta_id set not null;
alter table public.funnel_config drop constraint if exists funnel_config_pkey;
alter table public.funnel_config add primary key (conta_id, key);
create index if not exists funnel_config_conta_idx on public.funnel_config (conta_id);

-- 6) Fase B: registra se a conta já passou pela escolha de plano (assinantes
--    novos escolhem no primeiro acesso; a conta 0 — já criada 'completo' —
--    não precisa passar pela telinha de escolha).
alter table public.contas add column if not exists plano_definido_em timestamptz;
update public.contas set plano_definido_em = now()
where id = (select id from public.contas order by id asc limit 1) and plano_definido_em is null;

-- 5) diag_instagram_leads: a chave lógica `lead_ref` era globalmente
--    única; agora só precisa ser única DENTRO da conta (dois tenants
--    nunca vão colidir no mesmo lead_ref gerado no front, mas o índice
--    fica mais correto escopado por conta).
alter table public.diag_instagram_leads drop constraint if exists diag_instagram_leads_lead_ref_key;
create unique index if not exists diag_instagram_leads_conta_leadref_idx
  on public.diag_instagram_leads (conta_id, lead_ref);
