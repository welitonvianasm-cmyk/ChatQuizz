/**
 * Lógica compartilhada do sistema de qualificação configurável do quiz.
 *
 * Usado por:
 *   - netlify/functions/quiz-config.mjs → valida o documento salvo pelo painel
 *   - netlify/functions/save-lead.mjs   → recalcula qualificador/nível no
 *     servidor antes de disparar qualquer ação automática (nunca confia
 *     no valor que o navegador do lead mandou)
 *   - index.html (cópia manual, sem bundler neste projeto — mesma lógica,
 *     mantida em sincronia manualmente, igual ao PADRAO já era antes)
 *
 * Documento de config (chave 'quiz_perguntas' em funnel_config):
 *   {
 *     perguntas:     [{ id, q, multi, ativo, desempate, aberta, opts:[{ t, qualificador, nivel }] }],
 *       `aberta:true` = resposta em texto livre (o lead digita, sem opções).
 *       Não participa da votação de qualificador/nível nem pode ser critério
 *       de desempate — fica só como contexto (Cartão do Lead + Agente IA).
 *     qualificadores:[{ chave, nome, cor, ordem, ativo }],
 *     niveis:        [{ chave, nome, ordem }],
 *     resultados:    { por_nivel: { [chave]: { texto } }, por_qualificador: { [chave]: { texto } } },
 *     roteamento:    { [qualificadorChave]: { tipo: 'calcom'|'whatsapp'|'url'|'crm', calLink?, mensagem?, url? } },
 *   }
 */

const TIPOS_ROTEAMENTO = ['calcom', 'whatsapp', 'url', 'crm'];

/* ================================================================
   PADRÃO — seed de exemplo genérico, sem nicho específico. Serve de
   ponto de partida/demonstração até a conta publicar a própria config
   pelo painel — nunca deve remeter ao negócio de nenhum cliente real
   (nem em conteúdo, nem em tom).
   ================================================================ */
export const PADRAO = {
  perguntas: [
    { id: 'q1', q: 'Como você descreveria o seu momento atual?', multi: false, ativo: true, desempate: false, opts: [
      { t: 'Estou no início, ainda organizando as ideias', nivel: 'low' },
      { t: 'Já tenho experiência, mas sinto que falta direção', nivel: 'mid' },
      { t: 'Já sei o que quero, só preciso de um empurrão pra agir', nivel: 'high' },
    ]},
    { id: 'q2', q: 'O que mais te impede de avançar hoje?', multi: false, ativo: true, desempate: false, opts: [
      { t: 'Falta de clareza sobre o próximo passo', nivel: 'low' },
      { t: 'Falta de tempo', nivel: 'mid' },
      { t: 'Falta de confiança pra colocar em prática', nivel: 'mid' },
      { t: 'Já sei o que preciso fazer, só falta decidir', nivel: 'high' },
    ]},
    { id: 'q3', q: 'Quais áreas você sente que estão sendo <b>mais afetadas</b> por isso? Pode marcar mais de uma', multi: true, ativo: true, desempate: false, opts: [
      { t: 'Rotina e produtividade', nivel: 'high' },
      { t: 'Bem-estar emocional', nivel: 'high' },
      { t: 'Relacionamentos', nivel: 'high' },
      { t: 'Resultados financeiros', nivel: 'high' },
      { t: 'Tempo livre', nivel: 'high' },
    ]},
    { id: 'q4', q: 'Em uma escala de 1 a 5, o quanto você sente que já consegue agir sobre isso agora?', multi: false, ativo: true, desempate: false, opts: [
      { t: '1 - Sinto que ainda não consigo', nivel: 'low' },
      { t: '2', nivel: 'low' },
      { t: '3', nivel: 'mid' },
      { t: '4', nivel: 'high' },
      { t: '5 - Sinto que já consigo agir agora', nivel: 'high' },
    ]},
    { id: 'q5', q: 'Você já buscou ajuda profissional (mentoria, curso, consultoria) pra resolver isso?', multi: false, ativo: true, desempate: false, opts: [
      { t: 'Sim, e estou em acompanhamento', nivel: 'high' },
      { t: 'Sim, mas não funcionou', nivel: 'mid' },
      { t: 'Não, nunca busquei', nivel: 'low' },
    ]},
    { id: 'q6', q: 'Em qual <b>prazo</b> você gostaria de ver uma mudança real?', multi: false, ativo: true, desempate: false, opts: [
      { t: 'O quanto antes, preciso de uma mudança urgente', nivel: 'high' },
      { t: 'Em até 3 meses', nivel: 'mid' },
      { t: 'Sem pressa', nivel: 'low' },
    ]},
    { id: 'q7', q: 'Pensando no seu <b>orçamento disponível</b> pra investir nisso agora, qual faixa faz mais sentido?', multi: false, ativo: true, desempate: true, opts: [
      { t: 'Até R$ 1.500', qualificador: 'padrao' },
      { t: 'Entre R$ 1.500 e R$ 3.000', qualificador: 'padrao' },
      { t: 'Entre R$ 3.000 e R$ 6.000', qualificador: 'padrao' },
      { t: 'Entre R$ 6.000 e R$ 12.000', qualificador: 'padrao' },
      { t: 'Acima de R$ 12.000', qualificador: 'premium' },
    ]},
    { id: 'q8', q: 'Última: qual o orçamento disponível pra investir num programa de desenvolvimento?', multi: false, ativo: true, desempate: false, opts: [
      { t: 'Já defini um orçamento e quero investir agora', nivel: 'high' },
      { t: 'Preciso entender melhor a proposta pra avaliar', nivel: 'mid' },
      { t: 'Não tenho orçamento disponível no momento', nivel: 'low' },
    ]},
  ],
  qualificadores: [
    { chave: 'padrao', nome: 'Padrão', cor: '#22A55E', ordem: 0, ativo: true },
    { chave: 'premium', nome: 'Premium (WhatsApp)', cor: '#8B5CF6', ordem: 1, ativo: true },
  ],
  niveis: [
    { chave: 'low', nome: 'Baixa Consciência', ordem: 0 },
    { chave: 'mid', nome: 'Média Consciência', ordem: 1 },
    { chave: 'high', nome: 'Alta Consciência', ordem: 2 },
  ],
  resultados: {
    por_nivel: {
      low: { texto:
        '{nome}, li tudo o que você me contou.\n\n' +
        'O que eu percebo é que você está num momento de <b>Baixa Consciência</b>: você sente que precisa de uma mudança, mas ainda não deu o primeiro passo de verdade.\n\n' +
        '<b>Isso é mais comum do que parece.</b> A maioria das pessoas que chegam até aqui já pensou em mudar antes, mas algo sempre atrapalhou: falta de tempo, de clareza, ou a sensação de que "ainda não é a hora".\n\n' +
        '<b>A raiz do problema geralmente não é falta de vontade, é falta de direção clara.</b> Sem um caminho definido, cada tentativa vira um recomeço do zero, e isso cansa antes mesmo de dar resultado.\n\n' +
        '<b>Se isso continuar assim, 3 coisas tendem a acontecer:</b><br>• A sensação de estar andando em círculos vai continuar.<br>• O tempo que já passou sem mudança vai pesar cada vez mais.<br>• Vai ficar mais difícil recomeçar quanto mais tempo passar.\n\n' +
        '<b>A boa notícia: dar o primeiro passo certo já muda tudo.</b> Você não precisa ter todas as respostas agora, só precisa de uma direção clara.\n\n' +
        '💬 <i>"Você não precisa ver a escada inteira, só precisa dar o primeiro passo."</i>' },
      mid: { texto:
        '{nome}, li tudo o que você me contou.\n\n' +
        'O que eu percebo é que você está num momento de <b>Média Consciência</b>: você já sabe que precisa de ajuda, mas ainda está avaliando se vale investir tempo e recursos nisso agora.\n\n' +
        '<b>Você já está no caminho certo, só falta decisão.</b> Diferente de quem ainda nem começou a pensar no assunto, você já entende o problema, só não deu o passo final.\n\n' +
        '<b>A hesitação geralmente vem do medo de investir e não funcionar.</b> Isso é natural, mas também é o que mantém tudo como está.\n\n' +
        '<b>Se você não decidir agora, 3 coisas tendem a acontecer:</b><br>• A situação atual vai continuar consumindo energia todo dia.<br>• Você vai continuar adiando uma decisão que, no fundo, já sabe que precisa tomar.<br>• O custo de esperar mais tende a ser maior que o de agir agora.\n\n' +
        '<b>Investir em resolver isso agora costuma custar menos do que continuar convivendo com o problema.</b>\n\n' +
        '💬 <i>"Decisão adiada também é uma decisão, só que geralmente a pior."</i>' },
      high: { texto:
        '{nome}, li tudo o que você me contou.\n\n' +
        'O que eu percebo é que você está num momento de <b>Alta Consciência</b>: você já sabe o que quer, já entende o problema, e chegou a hora de agir. Parabéns por chegar até aqui.\n\n' +
        '<b>Você está no ponto ideal pra dar o próximo passo.</b> Você já reconhece o valor de resolver isso e topa investir tempo e recursos no caminho certo.\n\n' +
        '<b>O que ainda falta é o suporte certo pra acelerar o processo.</b> Você sabe o que precisa fazer, mas ter alguém guiando o caminho reduz erro e ganha tempo.\n\n' +
        '<b>Se você não agir agora, o custo de esperar pode ser alto:</b><br>• A oportunidade de resolver isso rápido pode passar.<br>• Cada mês sem agir é um mês a mais convivendo com o problema.<br>• Quem começa agora sai na frente de quem fica só planejando.\n\n' +
        '<b>A hora de agir é agora.</b>\n\n' +
        '💬 <i>"O melhor momento pra começar foi ontem. O segundo melhor é agora."</i>' },
    },
    por_qualificador: {
      padrao: { texto:
        '<b>Você não precisa continuar enfrentando isso por conta própria.</b>\n\n' +
        'Esse é o espaço pra quem quer sair do "não sei o que fazer" pro "tenho um caminho claro". Aqui você encontra direção, prática e um grupo de apoio pra aplicar o que aprender de verdade.' },
      premium: { texto:
        '{nome}, pelo que você me contou, eu quero marcar uma conversa com você diretamente. Clica no botão aqui embaixo que a gente combina o melhor horário 👇' },
    },
  },
  roteamento: {
    padrao: { tipo: 'calcom', calLink: 'https://cal.com/sua-agenda' },
    premium: { tipo: 'whatsapp', auto: true, mensagem: 'Olá {nome}! Vi que você concluiu o quiz 💙 Vamos marcar nossa conversa?' },
  },
};

/* ================================================================
   VALIDAÇÃO — o documento inteiro é validado como uma unidade (mesma
   filosofia do sanitizar() original: nunca salva config que quebraria
   o quiz público).
   ================================================================ */
export function sanitizar(doc) {
  if (!doc || typeof doc !== 'object') return { erro: 'Configuração inválida.' };

  const qualificadores = Array.isArray(doc.qualificadores) ? doc.qualificadores : [];
  const niveis = Array.isArray(doc.niveis) ? doc.niveis : [];
  if (!qualificadores.length) return { erro: 'Precisa existir pelo menos 1 qualificador.' };
  if (!niveis.length) return { erro: 'Precisa existir pelo menos 1 nível de consciência.' };

  const qLimpo = [];
  const qChaves = new Set();
  for (const q of qualificadores) {
    const chave = String((q && q.chave) || '').trim().slice(0, 40);
    if (!chave || qChaves.has(chave)) return { erro: 'Todo qualificador precisa de uma chave única.' };
    qChaves.add(chave);
    qLimpo.push({
      chave, nome: String((q && q.nome) || chave).trim().slice(0, 60),
      cor: String((q && q.cor) || '#22A55E').trim().slice(0, 20),
      ordem: Number.isFinite(+((q && q.ordem))) ? +q.ordem : qLimpo.length,
      ativo: q.ativo !== false,
    });
  }

  const nLimpo = [];
  const nChaves = new Set();
  for (const n of niveis) {
    const chave = String((n && n.chave) || '').trim().slice(0, 40);
    if (!chave || nChaves.has(chave)) return { erro: 'Todo nível precisa de uma chave única.' };
    nChaves.add(chave);
    nLimpo.push({
      chave, nome: String((n && n.nome) || chave).trim().slice(0, 60),
      ordem: Number.isFinite(+((n && n.ordem))) ? +n.ordem : nLimpo.length,
    });
  }

  const qAtivos = new Set(qLimpo.filter((q) => q.ativo).map((q) => q.chave));

  const perguntas = Array.isArray(doc.perguntas) ? doc.perguntas : [];
  if (perguntas.length < 1 || perguntas.length > 30) return { erro: 'Quantidade de perguntas inválida (1 a 30).' };
  const pLimpo = [];
  let desempates = 0;
  for (const p of perguntas) {
    if (!p || typeof p !== 'object') return { erro: 'Pergunta inválida.' };
    const texto = String(p.q || '').trim().slice(0, 300);
    if (!texto) return { erro: 'Há uma pergunta sem texto.' };
    const aberta = !!p.aberta;
    const opts = [];
    if (!aberta) {
      for (const o of (Array.isArray(p.opts) ? p.opts : [])) {
        const t = String((o && o.t) || '').trim().slice(0, 140);
        if (!t) continue;
        const nivel = String((o && o.nivel) || '').trim();
        const qualificador = o && o.qualificador ? String(o.qualificador).trim() : '';
        if (nivel && !nChaves.has(nivel)) return { erro: `A opção "${t.slice(0, 30)}" aponta pra um nível que não existe.` };
        if (qualificador && !qChaves.has(qualificador)) return { erro: `A opção "${t.slice(0, 30)}" aponta pra um qualificador que não existe.` };
        const op = { t };
        if (nivel) op.nivel = nivel;
        if (qualificador) op.qualificador = qualificador;
        opts.push(op);
      }
    }
    const ativo = p.ativo !== false;
    // pergunta aberta é resposta em texto — não tem opções, não vota em
    // nada, e não pode ser critério de desempate (não gera um valor único
    // de qualificador/nível pra decidir empate)
    if (ativo && !aberta && opts.length < 2) return { erro: `A pergunta "${texto.slice(0, 40)}..." precisa de pelo menos 2 opções.` };
    const desempate = !aberta && !!p.desempate;
    if (desempate) desempates++;
    pLimpo.push({
      id: String(p.id || '').trim().slice(0, 30) || ('p' + pLimpo.length),
      q: texto, multi: aberta ? false : !!p.multi, ativo, desempate, aberta, opts,
    });
  }
  if (desempates > 1) return { erro: 'Só pode haver 1 pergunta marcada como critério de desempate.' };

  const roteamento = {};
  for (const chave of qChaves) {
    const r = (doc.roteamento && doc.roteamento[chave]) || {};
    const tipo = String(r.tipo || '').trim();
    if (!TIPOS_ROTEAMENTO.includes(tipo)) return { erro: `O qualificador "${chave}" precisa de um roteamento válido (Cal.com, WhatsApp, URL ou CRM).` };
    const rr = { tipo };
    if (tipo === 'calcom') {
      rr.calLink = String(r.calLink || '').trim().slice(0, 300);
      if (!rr.calLink) return { erro: `O qualificador "${chave}" está com roteamento Cal.com mas sem link.` };
    } else if (tipo === 'whatsapp') {
      rr.auto = !!r.auto;
      rr.botao = !!r.botao;
      if (!rr.auto && !rr.botao) return { erro: `O qualificador "${chave}" está com roteamento WhatsApp mas sem "Enviar mensagem automática" nem "Mostrar botão de WhatsApp" marcados — marque pelo menos um.` };
      if (rr.auto) {
        rr.mensagem = String(r.mensagem || '').trim().slice(0, 1000);
        if (!rr.mensagem) return { erro: `O qualificador "${chave}" está com envio automático marcado mas sem mensagem.` };
      }
      if (rr.botao) {
        rr.numero_ou_link = String(r.numero_ou_link || '').trim().slice(0, 300);
        if (!rr.numero_ou_link) return { erro: `O qualificador "${chave}" está com botão de WhatsApp marcado mas sem número ou link.` };
      }
    } else if (tipo === 'url') {
      rr.url = String(r.url || '').trim().slice(0, 500);
      if (!rr.url) return { erro: `O qualificador "${chave}" está com roteamento URL mas sem link.` };
    }
    roteamento[chave] = rr;
  }

  const resultados = { por_nivel: {}, por_qualificador: {} };
  for (const chave of nChaves) {
    const texto = String((doc.resultados && doc.resultados.por_nivel && doc.resultados.por_nivel[chave] && doc.resultados.por_nivel[chave].texto) || '').trim().slice(0, 4000);
    if (!texto) return { erro: `O nível "${chave}" está sem texto de resultado.` };
    resultados.por_nivel[chave] = { texto };
  }
  for (const chave of qChaves) {
    const texto = String((doc.resultados && doc.resultados.por_qualificador && doc.resultados.por_qualificador[chave] && doc.resultados.por_qualificador[chave].texto) || '').trim().slice(0, 4000);
    if (!texto) return { erro: `O qualificador "${chave}" está sem texto de convite.` };
    resultados.por_qualificador[chave] = { texto };
  }

  return { limpo: { perguntas: pLimpo, qualificadores: qLimpo, niveis: nLimpo, resultados, roteamento } };
}

/* ================================================================
   VOTAÇÃO POR MAIORIA — por eixo ('qualificador' | 'nivel'), com
   critério de desempate (pergunta marcada `desempate:true`). Perguntas
   de múltipla escolha contam UM voto só (o valor mais escolhido entre
   as próprias opções marcadas), pra não pesar mais que uma pergunta de
   escolha única.
   ================================================================ */
export function votar(perguntas, respostas, eixo) {
  const contagem = {};
  let valorDesempate = null;

  for (const p of perguntas) {
    if (!p || p.ativo === false || p.aberta) continue;   // pergunta aberta não vota (resposta é texto livre, não índice)
    const sel = respostas ? respostas[p.id] : null;
    const escolhidas = p.multi ? (Array.isArray(sel) ? sel : []) : (sel != null ? [sel] : []);
    if (!escolhidas.length) continue;

    let valorPergunta = null;
    if (p.multi) {
      const sub = {};
      escolhidas.forEach((idx) => {
        const o = p.opts && p.opts[idx];
        const v = o && o[eixo];
        if (!v) return;
        sub[v] = (sub[v] || 0) + 1;
      });
      let max = -1;
      for (const v of Object.keys(sub)) if (sub[v] > max) { max = sub[v]; valorPergunta = v; }
    } else {
      const o = p.opts && p.opts[escolhidas[0]];
      valorPergunta = (o && o[eixo]) || null;
    }
    if (!valorPergunta) continue;
    contagem[valorPergunta] = (contagem[valorPergunta] || 0) + 1;
    if (p.desempate) valorDesempate = valorPergunta;
  }

  const chaves = Object.keys(contagem);
  if (!chaves.length) return null;
  const max = Math.max(...chaves.map((k) => contagem[k]));
  const empatados = chaves.filter((k) => contagem[k] === max);
  if (empatados.length > 1 && valorDesempate && empatados.includes(valorDesempate)) return valorDesempate;
  return empatados[0];
}

/* ================================================================
   TEMPLATE — interpolação simples de variáveis tipo {nome}.
   ================================================================ */
export function interpolar(texto, vars) {
  return String(texto || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
}

/* respostas cruas ({perguntaId: índice(s) | texto}) -> pares legíveis
   {pergunta, resposta}. Compartilhado por save-lead.mjs (espelho no
   MentoriaHub) e agente-processar.mjs (contexto do Agente IA) — pergunta
   aberta usa o texto digitado direto, as demais resolvem o índice pro
   texto da opção escolhida. */
export function respostasLegiveis(perguntas, respostas) {
  if (!Array.isArray(perguntas) || !respostas) return [];
  return perguntas.map((p) => {
    const r = respostas[p.id];
    if (r === undefined || r === null) return null;
    if (p.aberta) {
      const texto = String(r || '').trim();
      return texto ? { pergunta: p.q, resposta: texto } : null;
    }
    const idxs = Array.isArray(r) ? r : [r];
    const textos = idxs.map((i) => (p.opts && p.opts[i] && p.opts[i].t) || '').filter(Boolean);
    return textos.length ? { pergunta: p.q, resposta: textos.join(', ') } : null;
  }).filter(Boolean);
}

/* Busca e valida a config publicada (usado tanto pelo GET público de
   quiz-config.mjs quanto pelo recálculo server-side em save-lead.mjs).
   Escopada por conta — cada assinante tem seu próprio quiz configurado. */
export async function carregarConfigPublicada(SB_URL, H, contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.quiz_perguntas&select=value&limit=1`, { headers: H });
    if (!r.ok) return { doc: PADRAO, personalizado: false };
    const rows = await r.json();
    if (!rows[0] || !rows[0].value) return { doc: PADRAO, personalizado: false };
    const salvo = JSON.parse(rows[0].value);
    const v = sanitizar(salvo);
    if (v.limpo) return { doc: v.limpo, personalizado: true };
  } catch { /* usa padrão */ }
  return { doc: PADRAO, personalizado: false };
}
