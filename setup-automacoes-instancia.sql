-- ================================================================
-- Escolha de número (instância WhatsApp) por Automação — só relevante
-- pra quem tem mais de 1 número conectado. Sem escolher, continua usando
-- o número padrão da conta, exatamente como já era. Seguro: só ADICIONA
-- colunas. Pode rodar mais de 1x.
-- ================================================================

alter table public.automacoes
  add column if not exists instancia_id bigint references public.wa_instancias(id) on delete set null;

-- guarda qual número foi de fato escolhido NO MOMENTO que o disparo foi
-- criado (snapshot, igual já acontece com a mensagem) — null = usa o
-- número padrão da conta na hora de enviar, comportamento de sempre.
alter table public.disparos
  add column if not exists instancia_nome text;
