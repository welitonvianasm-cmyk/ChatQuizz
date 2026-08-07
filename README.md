# Diagnóstico de Crescimento Orgânico no Instagram — Core Audience

Funil conversacional (estilo chat, inspirado na mecânica de type.viverdeia.ai) que qualifica leads
em 8 etapas com **análise ao vivo do perfil via Apify**, entrega um **pré-diagnóstico por IA** e
fecha com um **presente (Template de 30 Reels Virais)** resgatável via **agendamento no modal Cal.com**.

## Fluxo

| # | Etapa | O que acontece por trás |
|---|---|---|
| 1 | Nome | — |
| 2 | WhatsApp | valida DDD real → mensagem personalizada pelo estado · **1º save (parcial)** |
| 3 | E-mail | correção de typo (gmail.con→gmail.com) · **save (contato)** |
| 4 | @ do Instagram | **Apify puxa o perfil ao vivo** → card com foto, seguidores, posts, selo → "É você?" |
| 5 | Escolha do reel | strip horizontal com os últimos reels (capa + views via proxy) → lead escolhe 1 p/ análise |
| 6 | Nicho | nicho detectado pela bio vem **primeiro** na lista → depois roda o **PRÉ-DIAGNÓSTICO** |
| — | Pré-diagnóstico | **transcreve o áudio do reel** (actor Apify, ~US$0,01) e o Claude analisa o ROTEIRO falado pelo Método CORE (gancho falado, corpo, CTA) + números reais. Sem transcrição → analisa a legenda |
| 7 | Maior desafio | — |
| 8 | Faturamento no IG | calcula score (usa nº REAL de seguidores) · save (completo) |
| 🎁 | Presente | "Template dos 30 Reels Virais" → resgate **agendando a Sessão** |
| 📅 | Agenda inline | calendário nativo direto no chat (dias/horários do bloco `CONFIG.AGENDA`) — 1 toque agenda |
| ✅ | Agendou | confirma no chat e salva `status='agendado'` + `agendamento_em` (data/hora ISO) no Supabase |

**Degradação graciosa em camadas** (o funil NUNCA trava):
- Sem `APIFY_API_KEY` / perfil não encontrado → pergunta "quantos seguidores" no lugar do reel (fluxo v1)
- Sem `ANTHROPIC_API_KEY` → pré-diagnóstico vira template local **com os mesmos números reais**
- Sem `CALCOM_URL` → botão de resgate abre WhatsApp com mensagem pré-preenchida
- Funções fora do ar → tudo segue, leads ficam só no localStorage do lead

## Configurar antes de publicar

### 1. Bloco `CONFIG` no [index.html](index.html)
| Chave | O quê |
|---|---|
| `WHATSAPP_NUMERO` | seu número, só dígitos (ex: `5511987654321`) |
| `AGENDA` | regras do calendário inline: `diasSemana`, `horarios`, `diasAdiante`, `minHorasAntecedencia` |
| `AVATAR_URL` | troque o logo por **sua foto** (recorte quadrado) — conexão humana converte mais |

> **Motor Cal.com invisível**: com `CALCOM_API_KEY` + `CALCOM_EVENT_TYPE_ID` no Netlify,
> a agenda inline mostra os **horários reais** do seu Cal.com e cria o **booking de verdade**
> via API (o lead nunca vê o Cal.com). O booking dispara o webhook `BOOKING_CREATED` →
> sua integração calcom-sprinthub joga o lead no funil Comercial automaticamente.
> Sem as envs, cai nas regras locais do `CONFIG.AGENDA` e salva só no Supabase.
>
> **Página da reunião**: `call.html?id={booking_uid}` (ou `?t={ISO}&n={nome}` no modo local) —
> countdown, botão "Entrar na reunião" (libera 15 min antes, com o link de vídeo do booking)
> e "Adicionar ao Google Agenda". O lead recebe o link na confirmação do chat.

### 2. Régua de qualificação (bloco `SCORING`)
Pontos por faixa de seguidores/faturamento + corte `QUALIFICADO_MIN` (hoje: 6).
O score usa o número REAL de seguidores quando o Apify responde.

### 3. Variáveis de ambiente no Netlify
| Variável | Obrigatória? | Pra quê |
|---|---|---|
| `SUPABASE_DIAG_SERVICE` | Sim | chave **service_role** do projeto Supabase **dedicado** ao funil (só existe como env de backend — nunca no front). O projeto só contém a tabela `diag_instagram_leads` (criada pelo [setup.sql](setup.sql) — rode 1x no SQL Editor), então o alcance da chave fica contido nele |
| `SUPABASE_DIAG_URL` | Sim | URL do projeto dedicado (`https://aktktxizmpwckvxbdjzf.supabase.co`) |
| `SUPABASE_DIAG_KEY` | Não | anon do mesmo projeto, só como fallback. Não serve pros updates: no RLS do Postgres, UPDATE com WHERE e upsert passam pelas policies de SELECT — cliente write-only não atualiza linha específica |
| `APIFY_API_KEY` | Recomendada | card de perfil + reels ao vivo (mesma key do quiz-core-educacao) |
| `APIFY_ACTOR` | Não | padrão `apify~instagram-profile-scraper` |
| `ANTHROPIC_API_KEY` | Não | pré-diagnóstico gerado por IA (sem ela, templates com números reais) |
| `DIAGNOSIS_MODEL` | Não | padrão `claude-haiku-4-5` (prompt do método é grande e a janela da função é curta) |
| `CALCOM_API_KEY` | Sim (motor invisível) | **Bearer token** da API interna do Cal (`/interno`). Liga o motor de agendamento invisível: agenda inline com horários reais + booking criado pela API, o lead nunca vê o Cal |
| `CALCOM_BASE_URL` | Sim (motor invisível) | base da API interna = `https://<sua-instancia-cal>/interno` (sem `/v2`) |
| `CALCOM_EVENT_TYPE_ID` | Sim | ID do event type da trilha **PADRÃO** (<10k) = `95` ("Conheça o Software Core Audience"). ⚠️ precisa ter disponibilidade configurada no Cal — sem horários, padrão cai na agenda local |
| `CALCOM_EVENT_TYPE_ID_AUDIENCE` | Sim | trilha **10k+ não-médico** = `91` ("Conheça o Método Core Audience") |
| `CALCOM_EVENT_TYPE_ID_PREMIUM` | Não | fallback do premium se não houver pool de vendedores (normalmente desnecessário — os closers já têm eventTypeId no código) |
| `CAL_EMBED_VENDEDORES` | Não | **pool de vendedores** (JSON) usado pelo motor invisível E pelo embed de fallback. Cada item: `{nome, eventTypeId, link, percent?, trilha}`. Default no código: trilha `premium` com Baldan 35% (eventType 47) + Douglas (46)/Sabrina (43)/Áquila (44) dividindo 65%. Sorteio ponderado decide o closer; a agenda inline mostra os horários reais DELE e cria o booking. Pra ligar a trilha padrão com closers, adicione itens `trilha:"padrao"` aqui |
| `DASHBOARD_TOKEN` | Sim (p/ painel) | senha do **painel administrativo** [dashboard.html](dashboard.html). Sem ela, `/api/metrics` responde 503 (nunca abre os dados). O painel guarda o token no `localStorage` (digita 1x por navegador) |
| `FB_CAPI_TOKEN` | Não (p/ Meta) | token da **API de Conversões** do Meta (Events Manager → Settings). Liga o disparo server-side do evento `Lead` (médico). Só no backend. Prefira um token de **System User** (permanente) — o de usuário comum expira |
| `FB_PIXEL_ID` | Não | ID do Pixel (default no código: `943872144205445`). O Pixel no front usa esse ID fixo no snippet do `<head>` |
| `FB_TEST_EVENT_CODE` | Não | se setado, manda os eventos CAPI pro **Test Events** do Events Manager (não contam como conversão real) — útil pra validar |

## Painel administrativo — [dashboard.html](dashboard.html)

Acesse `/(...)/dashboard.html`, digite a `DASHBOARD_TOKEN` e veja, com filtro de período (Tudo/30d/7d/Hoje):
- **KPIs**: total de leads, **agendaram reunião** (destaque), completaram o funil, qualificados (score ≥ 6), **médicos (premium)** e reuniões futuras.
- **Funil de conversão** acumulado (iniciaram → contato → completaram → agendaram) com a queda de cada etapa.
- **Agendamentos por vendedor** (closer) e **trilha** premium vs. padrão.
- Quebra por **renda**, **nicho** (ambas com quantos agendaram), **seguidores**, **desafio**, **UF** e **leads/dia**.
- **Próximas reuniões** (futuras, ordenadas) e **tabela de todos os leads** com busca e **export CSV**.

A leitura passa pela função `metrics.mjs` (service_role no backend) porque a tabela é RLS write-only — o front nunca lê o Supabase direto. Token comparado em tempo ~constante; só colunas selecionadas (sem transcrição/bio/foto crua).

## Deploy

```bash
cd diagnostico-instagram
netlify deploy --prod
```

Leads chegam na tabela própria `diag_instagram_leads` (projeto Supabase dedicado), incluindo:
dados do perfil (seguidores, bio, categoria...), o reel escolhido (views/likes/caption),
transcrição, `nicho_detectado`, `lead_score`, `qualificado`, trilha/vendedor e agendamento.
Leitura só pelo painel (Table Editor) — a chave anon do funil é write-only por RLS.

## Funções (netlify/functions)

- `instagram-profile.mjs` — Apify em modo **assíncrono** (`action:start` dispara o run e devolve runId;
  `action:poll` checa e entrega perfil + reels + nicho). O front polla a cada 2,5s por até 55s com
  mensagens de progresso — scraping de 15-40s não estoura o teto da função Netlify (~10s)
- `proxy-image.mjs` — proxy p/ imagens do CDN do Instagram (hotlink block)
- `transcribe-reel.mjs` — transcrição do áudio do reel via Apify (start+poll; actor configurável
  por `APIFY_TRANSCRIPT_ACTOR`, padrão `sian.agency~instagram-ai-transcript-extractor`)
- `ai-diagnosis.mjs` — pré-diagnóstico via Claude (roteiro transcrito como fonte principal;
  fallback legenda; métricas pré-calculadas no prompt)
- `save-lead.mjs` — upsert atômico por `lead_ref` (on_conflict + merge-duplicates) na tabela
  própria do projeto dedicado, com a service_role via env de backend
- `metrics.mjs` — leitura agregável dos leads pro painel (`/api/metrics`), protegida por
  `DASHBOARD_TOKEN`, com a service_role; pagina o PostgREST (Range) até trazer tudo
- `fb-capi.mjs` — Meta Conversions API (`/api/fb-event`): evento `Lead` server-side SÓ p/
  médico (trilha premium), dados hasheados (SHA-256), deduplicado com o Pixel pelo `event_id`.
  O Pixel no `<head>` do index.html dispara o `Lead` no navegador; a função espelha no servidor

## Próximas extensões possíveis

- Página `politica-de-privacidade.html` linkada no texto LGPD
- Dashboard: o `dashboard.html` do quiz-core-educacao lê a mesma tabela (filtrar pelo `source_page`)
- Webhook pós-agendamento do Cal.com → disparo automático do template por e-mail/WhatsApp
