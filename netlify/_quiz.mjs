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
 *     perguntas:     [{ id, q, multi, ativo, desempate, opts:[{ t, qualificador, nivel }] }],
 *     qualificadores:[{ chave, nome, cor, ordem, ativo }],
 *     niveis:        [{ chave, nome, ordem }],
 *     resultados:    { por_nivel: { [chave]: { texto } }, por_qualificador: { [chave]: { texto } } },
 *     roteamento:    { [qualificadorChave]: { tipo: 'calcom'|'whatsapp'|'url'|'crm', calLink?, mensagem?, url? } },
 *   }
 */

const TIPOS_ROTEAMENTO = ['calcom', 'whatsapp', 'url', 'crm'];

/* ================================================================
   PADRÃO — seed inicial, migrado à mão do quiz de 8 perguntas original.
   Mantém o comportamento de hoje até alguém editar pelo painel. A
   pontuação low/mid/high de cada opção virou um `nivel` único (o de
   maior pontuação; empate resolvido priorizando high > mid > low) —
   é uma conversão com perda, revisar com respostas reais antes de
   publicar em produção.
   ================================================================ */
export const PADRAO = {
  perguntas: [
    { id: 'q1', q: 'Pra começar: qual a sua idade?', multi: false, ativo: true, desempate: false, opts: [
      { t: '🌻 30-45', nivel: 'high' },
      { t: '🌳 46-60', nivel: 'high' },
      { t: '🕊️ 61+', nivel: 'high' },
    ]},
    { id: 'q2', q: 'Como você se sente cuidando de seus pais?', multi: false, ativo: true, desempate: false, opts: [
      { t: '😩 Exausta', nivel: 'low' },
      { t: '🤯 Sobrecarregada', nivel: 'mid' },
      { t: '🧘‍♀️ Em Paz', nivel: 'high' },
    ]},
    { id: 'q3', q: 'Quais áreas da sua vida você sente que estão sendo <b>mais afetadas</b>? Pode marcar mais de uma 🙂', multi: true, ativo: true, desempate: false, opts: [
      { t: '💪 Saúde física', nivel: 'high' },
      { t: '🧠 Saúde mental', nivel: 'high' },
      { t: '❤️ Relacionamentos', nivel: 'high' },
      { t: '💼 Carreira/Trabalho', nivel: 'high' },
      { t: '🎨 Tempo livre/Hobbies', nivel: 'high' },
    ]},
    { id: 'q4', q: 'Em uma escala de 1 a 5, o quanto você se sente <b>culpada</b> por não conseguir "dar conta de tudo"?', multi: false, ativo: true, desempate: false, opts: [
      { t: '😊 1 - Nada culpada', nivel: 'high' },
      { t: '🙂 2', nivel: 'high' },
      { t: '😐 3', nivel: 'mid' },
      { t: '🙁 4', nivel: 'low' },
      { t: '😔 5 - Extremamente culpada', nivel: 'low' },
    ]},
    { id: 'q5', q: 'Você já buscou ajuda profissional (terapia, grupos de apoio...) pra lidar com o estresse do cuidado?', multi: false, ativo: true, desempate: false, opts: [
      { t: '🌱 Sim, e estou em acompanhamento', nivel: 'high' },
      { t: '💔 Sim, mas não funcionou', nivel: 'mid' },
      { t: '🤔 Não, nunca busquei', nivel: 'low' },
    ]},
    { id: 'q6', q: '🌻 Qual é a renda média <b>mensal</b> da sua família?', multi: false, ativo: true, desempate: true, opts: [
      { t: 'Entre R$ 1.500,00 e R$ 2.500,00', nivel: 'mid', qualificador: 'comunidade' },
      { t: 'Entre R$ 2.500,00 e R$ 5.000,00', nivel: 'high', qualificador: 'comunidade' },
      { t: 'Entre R$ 5.000,00 e R$ 10.000,00', nivel: 'high', qualificador: 'comunidade' },
      { t: 'Entre R$ 10.000,00 e R$ 20.000,00', nivel: 'high', qualificador: 'comunidade' },
      { t: 'Acima de R$ 20.000,00', nivel: 'high', qualificador: 'premium' },
    ]},
    { id: 'q7', q: 'Em qual <b>prazo</b> você gostaria de começar a sentir uma melhora significativa na sua vida?', multi: false, ativo: true, desempate: false, opts: [
      { t: '🚨 O mais rápido possível, preciso de uma mudança urgente!', nivel: 'high' },
      { t: '⏳ Em até 3 meses', nivel: 'mid' },
      { t: '🕰️ Não tenho pressa', nivel: 'low' },
    ]},
    { id: 'q8', q: 'Última: qual o <b>orçamento disponível</b> pra investir em um programa de desenvolvimento pessoal?', multi: false, ativo: true, desempate: false, opts: [
      { t: '💰 Já tenho um orçamento definido e estou pronta para investir.', nivel: 'high' },
      { t: '🤔 Preciso entender melhor o programa para avaliar o investimento.', nivel: 'mid' },
      { t: '💸 Não tenho orçamento disponível no momento.', nivel: 'low' },
    ]},
  ],
  qualificadores: [
    { chave: 'comunidade', nome: 'Comunidade', cor: '#22A55E', ordem: 0, ativo: true },
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
        '{nome}, li tudo o que você me contou, e li com muito carinho 🌿\n\n' +
        'O que eu percebo é que você está num momento de <b>Baixa Consciência</b>. Você ainda não entendeu que precisa mergulhar fundo na transformação. Talvez ainda esteja resistindo à ideia de priorizar a si mesma.\n\n' +
        "<b>Você está no modo 'piloto automático' do cuidado.</b> A rotina te engoliu, e você se sente presa a um ciclo de obrigações. A ideia de mudar parece distante e até um pouco assustadora.\n\n" +
        '<b>A raiz do problema: a dificuldade em se priorizar.</b> Você se sente culpada ao pensar em si mesma, como se estivesse negligenciando seus pais. Essa culpa te impede de buscar soluções e perpetua o ciclo de exaustão.\n\n' +
        '<b>Se você continuar nesse caminho, 3 coisas podem acontecer:</b><br>• Sua saúde física e mental se deteriorarão cada vez mais.<br>• Seus relacionamentos se desgastarão, gerando isolamento e ressentimento.<br>• Você perderá sua identidade e seus sonhos, vivendo apenas em função do cuidado.\n\n' +
        '<b>É possível cuidar sem se perder de si mesma.</b> Priorizar seu bem-estar não é egoísmo, mas sim uma necessidade para que você possa oferecer o melhor cuidado aos seus pais. Ao se fortalecer emocionalmente, você se torna uma cuidadora mais presente, equilibrada e feliz.\n\n' +
        '💬 <i>"Cuidar de si não é egoísmo, é autopreservação, e autopreservação é um ato de guerra."</i>' },
      mid: { texto:
        '{nome}, li tudo o que você me contou, e li com muito carinho 🌿\n\n' +
        'O que eu percebo é que você está num momento de <b>Média Consciência</b>. Você já reconhece que precisa de ajuda, mas ainda está hesitante em investir tempo e recursos em si mesma. Você está no caminho certo, mas precisa de um empurrãozinho.\n\n' +
        "<b>Você está no 'meio do caminho' da transformação.</b> Você sente o peso do cuidado, mas também vislumbra a possibilidade de uma vida mais equilibrada. A dúvida é: como chegar lá?\n\n" +
        '<b>A hesitação em investir em si mesma te impede de avançar.</b> Você sabe que precisa de ajuda, mas se sente insegura em gastar tempo e dinheiro em um programa. O medo de não funcionar te paralisa e te mantém presa à rotina.\n\n' +
        '<b>Se você não tomar uma atitude agora, 3 coisas podem acontecer:</b><br>• O estresse crônico se intensificará, afetando sua saúde e bem-estar.<br>• A sobrecarga emocional te deixará mais irritada e impaciente com seus pais.<br>• Você perderá oportunidades de se reconectar com seus hobbies e paixões.\n\n' +
        '<b>Investir em você é investir no melhor cuidado para seus pais.</b> Ao se fortalecer emocionalmente, você se torna uma cuidadora mais eficiente, presente e amorosa.\n\n' +
        '💬 <i>"Seja a mudança que você quer ver no mundo."</i>' },
      high: { texto:
        '{nome}, li tudo o que você me contou, e li com muito carinho 🌿\n\n' +
        'O que eu percebo é que você está num momento de <b>Alta Consciência</b>. Você está decidida a transformar sua vida e reconquistar sua felicidade. Você sabe que precisa de um suporte especializado e está pronta para investir em si mesma. Parabéns!\n\n' +
        '<b>Você está no ponto ideal para a transformação!</b> Você já reconhece a importância de priorizar seu bem-estar e está disposta a investir tempo e recursos em um programa que te ajude a reconquistar sua vida.\n\n' +
        '<b>Ainda existe uma lacuna entre o desejo e a ação.</b> Você já sabe o que precisa fazer, mas sente que precisa de um suporte especializado para te guiar e te manter motivada ao longo do processo.\n\n' +
        '<b>Se você não agir agora, o custo da espera pode ser alto:</b><br>• Perder a oportunidade de viver uma vida plena e realizada.<br>• Ver seus sonhos e projetos pessoais se distanciarem cada vez mais.<br>• Arrepender-se de não ter tomado uma atitude antes que a situação se tornasse insustentável.\n\n' +
        '<b>A hora de agir é agora! Não espere mais para reconquistar sua vida.</b>\n\n' +
        '💬 <i>"O melhor momento para plantar uma árvore foi há 20 anos. O segundo melhor momento é agora."</i>' },
    },
    por_qualificador: {
      comunidade: { texto:
        '<b>Você não precisa continuar carregando isso sozinha.</b>\n\n' +
        'A <b>Comunidade</b> é o espaço para filhos cuidadores que precisam de apoio, direção e força para cuidar sem se perder no processo. Aqui você vai sair do modo <i>"eu não aguento mais e não sei o que fazer"</i> para o modo <i>"eu tenho direção, apoio e ferramentas para cuidar melhor sem me abandonar pelo caminho."</i>' },
      premium: { texto:
        '{nome}, pelo que você me contou, eu quero marcar nossa conversa pessoalmente com você. Clica no botão aqui embaixo que a gente combina o melhor horário. Pode vir, é comigo mesma que você vai falar 👇' },
    },
  },
  roteamento: {
    comunidade: { tipo: 'calcom', calLink: 'https://cal.com/sua-agenda/comunidade' },
    premium: { tipo: 'whatsapp', mensagem: 'Olá {nome}! Vi que você concluiu o quiz 💚 Vamos marcar nossa conversa?' },
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
    const opts = [];
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
    const ativo = p.ativo !== false;
    if (ativo && opts.length < 2) return { erro: `A pergunta "${texto.slice(0, 40)}..." precisa de pelo menos 2 opções.` };
    const desempate = !!p.desempate;
    if (desempate) desempates++;
    pLimpo.push({
      id: String(p.id || '').trim().slice(0, 30) || ('p' + pLimpo.length),
      q: texto, multi: !!p.multi, ativo, desempate, opts,
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
      rr.mensagem = String(r.mensagem || '').trim().slice(0, 1000);
      if (!rr.mensagem) return { erro: `O qualificador "${chave}" está com roteamento WhatsApp mas sem mensagem.` };
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
    if (!p || p.ativo === false) continue;
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
