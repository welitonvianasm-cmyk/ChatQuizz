# 🎨 Guia de Personalização — ChatQuiz

Tudo que pode (e deve) ser adaptado para o projeto Suavitatis, organizado por bloco.
Os textos estão na íntegra — edite direto neste arquivo (pode escrever por cima ou
anotar ao lado) e devolva para o Claude aplicar no código.

Legenda dos "curingas" que o sistema preenche sozinho:
- `{primeiro}` = primeiro nome do lead · `{instagram}` = @ do perfil
- `{nicho}` = nicho escolhido · `{seguidores}` = faixa de seguidores

---

## 1. IDENTIDADE VISUAL

| Item | Hoje | Onde aparece |
|---|---|---|
| **Logo** | `logo.png` | Topo do site (em um selo escuro), favicon da aba, e como avatar reserva |
| **Foto do avatar** | `fabio.jpg` (foto do autor) | Rostinho que aparece ao lado de TODAS as mensagens do chat — conexão humana. **Trocar pela sua foto (recorte quadrado)** |
| **Imagem do produto** | vazio (usa um cartão desenhado) | Cartão do "presente" no final do quiz. Opcional: colocar uma imagem real do seu material |
| **Cor principal** | Roxo `#a155f2` (com gradiente `#a155f2 → #8b3fe0`) | Botões, barra de progresso, detalhes. Podemos trocar para a cor da Suavitatis |
| **Cor do selo do logo** | Quase preto `#0d0a1a` | Fundo atrás do logo no topo |
| **Dourado do presente** | `#f5a623` (gradiente `#f7b545 → #ef8f1f`) | Selo "PRESENTE DESBLOQUEADO" |
| **Fonte** | Inter (Google Fonts) | Todo o site |

## 2. TÍTULOS DO SITE (aba do navegador e Google)

- **Título da aba**: `Diagnóstico de Crescimento Orgânico | Core Audience`
- **Descrição (Google/compartilhamento)**: `Descubra em 2 minutos o que está travando o crescimento orgânico do seu perfil no Instagram.`
- **Texto ao lado do logo no topo**: `Diagnóstico de Crescimento Orgânico`
- **Contador de etapas**: `0 de 8` (formato "X de 8")
- **Aviso LGPD (rodapé do campo de resposta)**: `Ao continuar, você concorda que seus dados sejam usados para entrarmos em contato sobre o seu diagnóstico. Seus dados estão protegidos (LGPD).`

## 3. ⚠️ RASTREADOR DO META (FACEBOOK) — IMPORTANTE

O site está com o **Pixel do Meta do autor original** instalado (ID `943872144205445`).
Hoje, cada visita ao seu site enviaria dados para a conta de anúncios DELE.
**Decidir:** (a) remover o Pixel por enquanto, ou (b) trocar pelo seu Pixel ID
(se você anuncia no Instagram/Facebook). → Recomendo (a) remover até você precisar.

## 4. CONFIGURAÇÕES DE FUNCIONAMENTO (bloco CONFIG)

- **WHATSAPP_NUMERO**: `5511999999999` — número usado só como plano C se o cal.com falhar. Trocar pelo seu ou deixar assim (nunca será usado com o cal.com ativo).
- **AGENDA local (plano B)**: seg–sex, horários 09:00–11:00 e 14:00–17:00, janela de 14 dias, antecedência mínima de 3h. Só aparece se o cal.com estiver fora do ar.

## 5. REGRA DE QUALIFICAÇÃO (score do lead)

Pontos por faixa de seguidores: Menos de 1 mil = 1 · 1–5 mil = 2 · 5–20 mil = 3 · 20–50 mil = 4 · 50–100 mil = 5 · +100 mil = 6
Pontos por renda: Até R$5 mil = 1 · R$5–10 mil = 2 · R$10–20 mil = 4 · R$20–50 mil = 6 · +R$50 mil = 8
Bônus +1 se o desafio for de conversão ("Não converto em vendas" / "Seguidores não engajam")
**Qualificado** = 6 pontos ou mais → recebe a mensagem de "alto potencial"

---

# 📝 COPY DO FUNIL — mensagem por mensagem

## ETAPA 0 — Abertura + Nome

**Bot:** `Perfis que aplicam o conteúdo certo estão multiplicando o alcance em até **10x** e transformando seguidores em **vendas** — sem investir 1 real em anúncio. Quer descobrir o que está travando o crescimento do seu perfil?`

**Bot:** `Bora começar: qual seu nome?`

- Rótulo do campo: `Nome completo` · Dica dentro do campo: `Digite seu nome e sobrenome...`
- Erro se incompleto: `Digite nome e sobrenome 🙂`

## ETAPA 1 — WhatsApp

**Bot:** `Prazer, **{primeiro}**! 👊 Pra eu te enviar o resultado completo do diagnóstico, qual seu WhatsApp?`

- Rótulo: `WhatsApp` · Exemplo no campo: `(11) 99999-9999` (com seletor de país 🇧🇷)
- Erros: `Esse DDD não existe no Brasil 🤔` · `Celular começa com 9 depois do DDD` · `Número parece incompleto 🤔`

**Depois de responder, o bot elogia o estado do lead** (detectado pelo DDD). São 27 mensagens, uma por estado — exemplos:

- SP: `São Paulo — o mercado mais disputado de atenção do Brasil. Quem aparece com estratégia aqui fecha cliente toda semana.`
- RJ: `Rio de Janeiro — terra de marca pessoal forte. Perfil carioca com posicionamento certo vira referência rápido.`
- MG: `Minas Gerais — público fiel como poucos. Perfil mineiro que gera confiança transforma seguidor em cliente de anos.`
- *(…há uma para cada UF — todas seguem esse espírito de "seu estado é uma oportunidade". Posso listar todas se quiser mexer nelas uma a uma)*
- Fora do Brasil: `Show, recebido! 🌎`
- Reserva: `Show! Crescimento orgânico não tem fronteira — o método é o mesmo em qualquer canto.`

## ETAPA 2 — E-mail

**Bot:** `E qual seu melhor e-mail?`

- Rótulo: `E-mail` · Exemplo: `seu@email.com`
- Se detectar erro de digitação: `Hmm, esse e-mail parece ter um errinho de digitação. Você quis dizer **{sugestão}**?` · Botões: `Sim, usar o corrigido` / `Não, manter como digitei`

## ETAPA 3 — @ do Instagram

**Bot:** `Agora a parte boa: qual o **@** do seu perfil no Instagram? Vou dar uma olhada nele em tempo real 👀`

- Rótulo: `Seu @ do Instagram` · Erro: `Só letras, números, ponto e underline`

**Cartão de carregamento (enquanto a Apify busca o perfil):**
Título: `🔎 Analisando o **@{instagram}** ao vivo`
Passos: `Abrindo o perfil no Instagram` → `Lendo bio, seguidores e números` → `Carregando seus últimos reels` → `Organizando tudo pra você`

**Achou o perfil** (mostra cartão com foto, seguidores, posts): `Achei! Esse é você?` · Botões: `Sou eu ✅` / `Não é esse perfil`
Se não for: `Sem problema! Me passa o @ certinho então:`
**Não achou o perfil:** `Não consegui abrir o **@{instagram}** agora (pode ser privado ou novo) — sem problema, seguimos com o diagnóstico! 💪` → pergunta manual: `Quantos seguidores o perfil tem hoje?`

## ETAPA 4 — Escolha do Reel

**Bot:** `E olha o que eu separei: seus últimos reels. **Escolhe UM** pra eu analisar a fundo no seu diagnóstico 👇`

- Botão de pular: `Prefiro pular a análise de reel`
- Se não tem reels: `Não achei reels públicos recentes no perfil — sem problema, seguimos!`

## ETAPA 5 — Nicho

Se detectou pela bio: `Pela bio do **@{instagram}**, deu pra ver: seu nicho é **{nicho}**. Confere?` · Botões: `Confere ✅` / `É outro nicho` → `Sem problema — seleciona o nicho certo aqui:`
Se não detectou: `Antes de eu rodar a análise: em qual nicho o **@{instagram}** atua?`

**Lista de nichos (12):** Saúde & Bem-estar · Estética & Beleza · Fitness · Direito · Finanças & Investimentos · Educação & Concursos · Moda · Gastronomia & Food · Imobiliário · Marketing & Negócios · Serviços locais · Outro

## PRÉ-DIAGNÓSTICO (roda após o nicho, quando achou o perfil)

**Cartão de carregamento:** `🧠 Rodando o **Método CORE** no seu conteúdo`
Passos (com reel): `Transcrevendo o áudio do seu reel` → `Analisando o roteiro com os 7 Gatilhos` → `Medindo o Conteúdo Notável e o CTA` → `Calculando seu Score CORE`

**Introdução aos 3 pilares (cartão):**
`Antes do resultado, deixa eu te situar: o **Método CORE** mede 3 pilares — é o que separa um reel que viraliza de um que o algoritmo ignora.`
- 🎯 **Gatilho da Atenção** — *fazer a pessoa parar pra te assistir*
- 🔥 **Conteúdo Notável** — *fazer ela assistir e engajar até o final*
- 🎬 **CTA & Conversão** — *fazer ela agir e virar cliente do seu produto/serviço*
`Vou analisar o **Gatilho da Atenção** agora 👇 A análise completa dos 3 — com as correções — eu abro na sua **Sessão Estratégica**.`

- Botão para revelar: `Entendi, quero ver o resultado 👀`
- Alerta do gatilho: `🚨 O gatilho que mais faltou no seu gancho: **Gatilho da {nome}**` (opções: Atenção Imediata, Recompensa, Reconhecimento, Crença, Popularidade/Autoridade, Mistério, Disrupção)
- Pilares trancados: `A análise completa deste pilar fica disponível na sua sessão com o time — incluindo os ajustes recomendados pro seu perfil e os exemplos aplicados ao seu nicho.` + `🔒 As análises completas desses 2 pilares — e as correções — eu abro na sua **Sessão Estratégica**`

**"Sementes" de curiosidade (usadas no texto do diagnóstico):**
1. `Existem **7 Gatilhos da Atenção** que todo gancho precisa ativar — e na Sessão Estratégica eu te mostro os melhores pro seu caso.`
2. `Conteúdos que viralizam seguem **4 princípios obrigatórios e 7 elementos estratégicos** — e sabemos exatamente quais estão faltando no seu.`
3. `Existem **3 tipos de CTA estratégico** que transformam atenção em resultado real — e sabemos qual funciona melhor pro seu nicho.`

## ETAPA 6 — Maior desafio

**Bot:** `Me confirma uma coisa: qual é o **maior desafio** do seu perfil hoje?`

**Opções (6):** Alcance baixo (views travadas) · Falta de constância · Não sei o que postar · Seguidores não engajam · Não converto em vendas · Estou começando do zero

## ETAPA 7 — Renda

**Bot:** `Última pergunta: qual a sua **renda mensal** atualmente?`

**Opções (5):** Até R$5 mil/mês · R$5 a 10 mil/mês · R$10 a 20 mil/mês · R$20 a 50 mil/mês · Acima de R$50 mil/mês

## DIAGNÓSTICOS PRONTOS (plano B — quando NÃO houve análise por IA)

Um texto por desafio escolhido (6 no total). Exemplo do primeiro:

**"Alcance baixo (views travadas)":**
`**{primeiro}**, views travadas no **@{instagram}** quase nunca são "punição do algoritmo" — são sintoma de conteúdo que não segura os 3 primeiros segundos. No nicho de **{nicho}**, o perfil que domina gancho e retenção cresce mesmo postando menos. — Com {seguidores} de base, seu próximo salto não vem de postar mais — vem de reestruturar o formato do conteúdo pra ser distribuído pra quem ainda não te segue.`

*(há mais 5 no mesmo formato, um para cada desafio — todos no arquivo index.html, seção DIAGNOSTICOS. Posso trazer todos na íntegra quando você for reescrever)*

## FINAL — Fechamento + Presente + Agenda

**Fechamento (com pré-diagnóstico):** `Fechamos, **{primeiro}**. Seu maior gargalo — **{desafio}** — bate exatamente com o que vi no **@{instagram}**. E a boa notícia: é o tipo de coisa que se destrava rápido com o método certo.`
**Fechamento (sem):** `Fechou, **{primeiro}**! Cruzando suas respostas com os padrões que a gente mapeou em centenas de perfis... 🔍`

**Suspense:** `E o diagnóstico desbloqueou uma coisa pra você... 👀`

**Anúncio do presente:** `🎁 **PARABÉNS, {primeiro}!** Você acaba de ganhar o **TEMPLATE DOS 30 REELS VIRAIS** — os roteiros que usamos pra estourar perfis no seu nicho.`

**Cartão do produto (mockup):**
- Selo: `🎁 PRESENTE DESBLOQUEADO` · Kicker: `TEMPLATE CORE` · Título: `30 REELS VIRAIS`
- Subtítulo: `Roteiros prontos — gancho, estrutura e CTA — validados em perfis de **{nicho}**.`
- Itens: `#01 Gancho da Crença — "Tudo que te ensinaram sobre…"` · `#02 História de Transformação em 3 atos` · `#03 Plot Twist + CTA de salvamento` (borrado) · `🔒 +27 roteiros liberados na sessão`
- Preço: `~~R$197~~ **GRÁTIS** na Sessão Estratégica`

**Se qualificado:** `⚡ Pelo seu estágio, seu perfil entrou como **alto potencial** — aproveita a vaga.`

**Convite para agendar:** `Pra resgatar, agenda uma **reunião gratuita** pra conhecer o método de crescimento no Instagram que já gerou **+50 milhões de seguidores**, **3 bilhões de visualizações** e **100 mil clientes** — você sai com o template na mão. Toca no melhor horário 👇`
⚠️ *Esses números são do autor original — precisam ser trocados pelos SEUS números/prova social.*

**Cartão da agenda (cal.com embutido):** `Escolhe o melhor horário` · `Sessão de diagnóstico gratuita · online`
**Confirmado:** `Sessão agendada — Te esperamos lá!` · `✓ {dia} às {hora}` · `Confirmação chega no seu WhatsApp e e-mail.` · `📄 Minha página da reunião`
**Mensagem final:** `✅ **Agendado, {primeiro}!** Salvei sua **página da reunião** — lá tem o contador e os detalhes. Seu **Template dos 30 Reels Virais** está garantido. Até lá! 🚀`
**Horário ocupado:** `Eita — esse horário acabou de ser preenchido por outra pessoa 😅 Escolhe outro aqui:`
**Retomada após recarregar a página:** `Continuando de onde você parou 😉`

---

# 📄 PÁGINA DA REUNIÃO (call.html)

- Título da aba: `Sua Sessão Estratégica | Core Audience`
- Topo: logo + `Sessão Estratégica`
- Cabeçalho: `Sua reunião está confirmada 🎉` · `Sessão Estratégica de Crescimento Orgânico · 30 min · online`
- Contagem: `faltam pra sua sessão começar` · Ao vivo: `🔴 Sua sessão está acontecendo agora — entra!`
- Botão: `🎥 Entrar na reunião` · Evento no Google Agenda: `Sessão Estratégica — Core Audience`
- Lembrete: `🎁 **Não esquece:** seu **Template dos 30 Reels Virais** é entregue nessa sessão — junto com o plano de crescimento do seu perfil.`
- Rodapé: `Core Audience · chegue 2 minutinhos antes 😉`
- Sessão passada: `Essa sessão já aconteceu.`
- *(usa a foto `fabio.jpg` também — trocar junto com o avatar)*

# 🚫 PÁGINA DE ERRO (404.html)

`Página não encontrada` · `O endereço que você tentou acessar não existe.` *(neutra, pode ficar)*

# 🤖 PROMPT DA IA (netlify/_private.mjs)

O "cérebro" do pré-diagnóstico. Hoje está com um texto genérico que eu criei para o
site rodar. Para a IA analisar como VOCÊ analisaria, precisamos escrever juntos:
1. **Seu framework de análise** (o que você olha num perfil/conteúdo — seus "pilares")
2. **O tom do consultor** (hoje: "direto, prático e encorajador")
3. **O formato da resposta** (hoje: 1 ponto forte + 2 oportunidades)

---

# ✅ RESUMO — o que decidir primeiro

1. **Sua foto** (avatar do chat) e **seu logo** — me envie os arquivos
2. **Nome do quiz** (título da aba + texto do topo)
3. **Pixel do Meta**: remover ou trocar pelo seu (hoje envia dados pro autor!)
4. **O "presente"**: qual será o seu? (hoje: Template dos 30 Reels Virais, R$197)
5. **Prova social do convite final** (hoje: números do autor)
6. **Público/tema**: manter o foco "crescimento no Instagram" ou adaptar as perguntas para o seu público da Suavitatis?
7. **Cor principal**: manter o roxo ou usar a cor da sua marca?
