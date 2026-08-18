-- ================================================================
-- USUÁRIOS: flag global de superadmin (dono do QuizzHub).
-- Não é por conta — é uma credencial de STAFF, ligada a um login
-- específico. Nunca é exposta/editável em nenhuma tela de gestão de
-- equipe por conta (dash-users.mjs) — só é ligada aqui, direto no banco.
-- Idempotente — seguro rodar mais de uma vez.
-- ================================================================

alter table public.usuarios add column if not exists eh_superadmin boolean not null default false;

-- liga o flag pro SEU usuário (o dono do QuizzHub) — troque o e-mail se
-- quiser conceder a outra pessoa também, mas normalmente é só você.
update public.usuarios set eh_superadmin = true where email = 'welitonviana.sm@gmail.com';
