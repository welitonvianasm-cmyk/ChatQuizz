# QuizzHub

Quiz de captação de leads em formato de chat, com painel (dashboard) para gerenciar os leads captados.

Este projeto é independente — foi iniciado a partir de uma cópia de um projeto anterior, mas evoluiu (e vai continuar evoluindo) pra ser genérico e 100% configurável: perguntas, qualificadores, níveis de resultado, textos e roteamento de cada lead são editados pelo dashboard, sem precisar mexer em código.

## Stack

- **Front-end**: HTML/CSS/JS puro, sem framework nem build step. `index.html` (quiz público), `call.html` (confirmação de agendamento), `dashboard.html` (painel de administração).
- **Backend**: [Netlify Functions](https://docs.netlify.com/functions/overview/) (`netlify/functions/*.mjs`), sem framework — cada arquivo é uma function isolada.
- **Banco de dados**: [Supabase](https://supabase.com/) (Postgres), acessado via REST (PostgREST) a partir das functions, nunca diretamente do navegador.
- **WhatsApp** (opcional): [Evolution API](https://github.com/EvolutionAPI/evolution-api), auto-hospedado num serviço com processo persistente (ex: [Railway](https://railway.app/)) — necessário só se for usar a automação de mensagens/roteamento via WhatsApp.
- **Agendamento**: [Cal.com](https://cal.com/) (embed público).

## Estrutura

```
index.html                  quiz público (captação de lead)
call.html                   página de confirmação pós-agendamento
dashboard.html               painel administrativo (CRM)
404.html
netlify.toml                config de deploy, redirects e headers de segurança
netlify/functions/*.mjs      backend (uma function por arquivo)
netlify/_tokens.mjs          autenticação compartilhada do painel
netlify/_quiz.mjs            config padrão + votação por maioria do quiz (compartilhado entre functions)
setup*.sql                   migrações do schema do Supabase, em ordem de criação (ver ordem abaixo)
```

## Setup local

1. `netlify dev` (requer [Netlify CLI](https://docs.netlify.com/cli/get-started/)) — sobe o site + as functions localmente.
2. Num projeto Supabase novo, rode os arquivos `setup*.sql` nesta ordem: `setup.sql`, `setup-fix.sql`, `setup-card.sql`, `setup-crm.sql`, `setup-kanban2.sql`, `setup-kanban3.sql`, `setup-equipe.sql`, `setup-posvenda.sql`, `setup-resultado.sql`, `setup-alertas.sql`, `setup-whatsapp.sql`, `setup-quiz-config.sql`.
3. Configure as variáveis de ambiente abaixo no painel do Netlify (ou num `.env` local pro `netlify dev`).

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `SUPABASE_DIAG_URL` / `SUPABASE_DIAG_SERVICE` | conexão com o Supabase (Project URL + chave `service_role`, nunca exposta ao navegador) — **obrigatórias** |
| `DASHBOARD_TOKEN` | senha do admin do painel — **obrigatória** |
| `CALCOM_API_KEY` / `CALCOM_BASE_URL` | integração oficial com a API do Cal.com (opcional — o roteamento normal usa o link público configurado no Editor do Quiz, não precisa disso) |
| `EVOLUTION_URL` / `EVOLUTION_KEY` / `EVOLUTION_INSTANCE` | conexão com o WhatsApp (Evolution API), só necessário pra automação de mensagens |
| `WA_WEBHOOK_SECRET` | segurança do webhook de mensagens recebidas do WhatsApp (opcional) |

## Segurança

- O quiz (`index.html`) nunca fala com o Supabase diretamente — toda escrita/leitura passa pelas functions, que usam a chave `service_role` só no servidor.
- `netlify.toml` bloqueia acesso público a arquivos de configuração/schema (`*.sql`, `package.json`, `README.md`, `/netlify/*`) mesmo com a raiz publicada estaticamente.
- `dashboard.html` nunca pode ser embutido em iframe (`X-Frame-Options: DENY`).
