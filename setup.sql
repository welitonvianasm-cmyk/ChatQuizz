-- ================================================================
-- DIAGNÓSTICO INSTAGRAM — tabela própria do funil (Core Audience)
-- Cole este script inteiro no Supabase: painel → SQL Editor → Run.
--
-- SEGURO POR DESENHO:
--  • Só CRIA coisas novas (tabela diag_instagram_leads + policies dela).
--  • NÃO altera, não lê e não toca em NENHUMA tabela existente.
--  • RLS ligado: a chave `anon` só consegue INSERIR/ATUALIZAR nesta
--    tabela — nunca ler, nunca apagar, nunca acessar outras tabelas.
--    (Você lê normalmente pelo painel/Table Editor.)
-- ================================================================

create table if not exists public.diag_instagram_leads (
  id              bigint generated always as identity primary key,
  lead_ref        text not null unique,            -- id estável do lead (gerado no funil)
  status          text not null default 'parcial', -- parcial | contato | completo | agendado
  origem          text not null default 'diagnostico-instagram',

  -- contato
  nome            text not null default '',
  email           text not null default '',
  whatsapp        text not null default '',        -- E.164 (+55...)
  uf              text not null default '',

  -- respostas do funil
  instagram       text not null default '',
  nicho           text not null default '',
  nicho_detectado text not null default '',
  seguidores      text not null default '',
  dificuldade     text not null default '',
  renda           text not null default '',
  lead_score      int,
  qualificado     boolean,

  -- agendamento
  call_track      text not null default '',        -- premium | padrao
  vendedor        text not null default '',        -- closer sorteado
  agendado        boolean not null default false,
  agendamento_em  timestamptz,
  booking_uid     text not null default '',
  video_url       text not null default '',

  -- dados do perfil (scraping)
  ig_full_name    text not null default '',
  ig_bio          text not null default '',
  ig_pic_url      text not null default '',
  ig_followers    int,
  ig_following    int,
  ig_posts        int,
  ig_business     boolean,
  ig_categoria    text not null default '',
  ig_link_bio     text not null default '',
  ig_verificado   boolean,

  -- reel analisado
  reel_url        text not null default '',
  reel_caption    text not null default '',
  reel_views      bigint,
  reel_likes      int,
  reel_comments   int,
  reel_transcript text not null default '',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.diag_instagram_leads enable row level security;

-- a chave anon escreve (upsert do funil), mas NUNCA lê nem apaga
drop policy if exists diag_leads_insert on public.diag_instagram_leads;
create policy diag_leads_insert on public.diag_instagram_leads
  for insert to anon with check (true);

drop policy if exists diag_leads_update on public.diag_instagram_leads;
create policy diag_leads_update on public.diag_instagram_leads
  for update to anon using (true) with check (true);

-- updated_at automático a cada atualização
create or replace function public.diag_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists diag_touch on public.diag_instagram_leads;
create trigger diag_touch before update on public.diag_instagram_leads
  for each row execute function public.diag_touch_updated_at();

create index if not exists diag_leads_created_idx on public.diag_instagram_leads (created_at desc);
create index if not exists diag_leads_status_idx  on public.diag_instagram_leads (status);
create index if not exists diag_leads_agendado_idx on public.diag_instagram_leads (agendado) where agendado;
