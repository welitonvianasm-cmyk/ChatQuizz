/**
 * PERGUNTAS DO QUIZ — editáveis pelo painel (Configurações → Quiz).
 *
 *   GET  /api/quiz-config                       → { ok, perguntas, personalizado }
 *        (público: o quiz carrega daqui; sem config salva, devolve o PADRÃO)
 *   POST /api/quiz-config { token, perguntas }  → salva (SÓ administradora)
 *   POST /api/quiz-config { token, action:'restaurar' } → volta ao padrão
 *
 * REGRAS DE SEGURANÇA DO FUNIL:
 *   - Deve existir EXATAMENTE 1 pergunta-chave (opções com `destino`), ativa —
 *     é ela que decide Comunidade/Imersão/WhatsApp. Sem isso, o save é recusado.
 *   - Toda pergunta ativa precisa de pelo menos 2 opções com texto.
 * O PADRÃO abaixo espelha o QUIZ_PADRAO do index.html (manter em sincronia).
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE = 'quiz_perguntas';
const DESTINOS = ['comunidade', 'imersao', 'premium'];

const PADRAO = [
  { id: 'q1', q: 'Pra começar: qual a sua idade?', multi: false, ativo: true, opts: [
    { t: '🌻 30-45', s: { low: 1, mid: 2, high: 2 } },
    { t: '🌳 46-60', s: { low: 1, mid: 2, high: 2 } },
    { t: '🕊️ 61+', s: { low: 2, mid: 1, high: 2 } },
  ]},
  { id: 'q2', q: 'Como você se sente cuidando de seus pais?', multi: false, ativo: true, opts: [
    { t: '😩 Exausta', s: { low: 4, mid: 1, high: 0 } },
    { t: '🤯 Sobrecarregada', s: { low: 2, mid: 3, high: 0 } },
    { t: '🧘‍♀️ Em Paz', s: { low: 0, mid: 1, high: 4 } },
  ]},
  { id: 'q3', q: 'Quais áreas da sua vida você sente que estão sendo <b>mais afetadas</b>? Pode marcar mais de uma 🙂', multi: true, ativo: true, opts: [
    { t: '💪 Saúde física', s: { low: 1, mid: 2, high: 2 } },
    { t: '🧠 Saúde mental', s: { low: 1, mid: 2, high: 2 } },
    { t: '❤️ Relacionamentos', s: { low: 1, mid: 2, high: 2 } },
    { t: '💼 Carreira/Trabalho', s: { low: 1, mid: 2, high: 2 } },
    { t: '🎨 Tempo livre/Hobbies', s: { low: 1, mid: 2, high: 2 } },
  ]},
  { id: 'q4', q: 'Em uma escala de 1 a 5, o quanto você se sente <b>culpada</b> por não conseguir "dar conta de tudo"?', multi: false, ativo: true, opts: [
    { t: '😊 1 - Nada culpada', s: { low: 0, mid: 1, high: 4 } },
    { t: '🙂 2', s: { low: 1, mid: 2, high: 2 } },
    { t: '😐 3', s: { low: 2, mid: 2, high: 1 } },
    { t: '🙁 4', s: { low: 3, mid: 1, high: 1 } },
    { t: '😔 5 - Extremamente culpada', s: { low: 4, mid: 0, high: 1 } },
  ]},
  { id: 'q5', q: 'Você já buscou ajuda profissional (terapia, grupos de apoio...) pra lidar com o estresse do cuidado?', multi: false, ativo: true, opts: [
    { t: '🌱 Sim, e estou em acompanhamento', s: { low: 1, mid: 2, high: 2 } },
    { t: '💔 Sim, mas não funcionou', s: { low: 2, mid: 3, high: 0 } },
    { t: '🤔 Não, nunca busquei', s: { low: 3, mid: 1, high: 1 } },
  ]},
  { id: 'q6', q: '🌻 Qual é a renda média <b>mensal</b> da sua família?', multi: false, ativo: true, opts: [
    { t: 'Entre R$ 1.500,00 e R$ 2.500,00', s: { low: 2, mid: 2, high: 1 }, destino: 'comunidade' },
    { t: 'Entre R$ 2.500,00 e R$ 5.000,00', s: { low: 1, mid: 2, high: 2 }, destino: 'comunidade' },
    { t: 'Entre R$ 5.000,00 e R$ 10.000,00', s: { low: 1, mid: 2, high: 3 }, destino: 'comunidade' },
    { t: 'Entre R$ 10.000,00 e R$ 20.000,00', s: { low: 0, mid: 1, high: 4 }, destino: 'comunidade' },
    { t: 'Acima de R$ 20.000,00', s: { low: 0, mid: 1, high: 4 }, destino: 'premium' },
  ]},
  { id: 'q7', q: 'Em qual <b>prazo</b> você gostaria de começar a sentir uma melhora significativa na sua vida?', multi: false, ativo: true, opts: [
    { t: '🚨 O mais rápido possível, preciso de uma mudança urgente!', s: { low: 0, mid: 1, high: 4 } },
    { t: '⏳ Em até 3 meses', s: { low: 1, mid: 3, high: 1 } },
    { t: '🕰️ Não tenho pressa', s: { low: 4, mid: 1, high: 0 } },
  ]},
  { id: 'q8', q: 'Última: qual o <b>orçamento disponível</b> pra investir em um programa de desenvolvimento pessoal?', multi: false, ativo: true, opts: [
    { t: '💰 Já tenho um orçamento definido e estou pronta para investir.', s: { low: 0, mid: 1, high: 4 } },
    { t: '🤔 Preciso entender melhor o programa para avaliar o investimento.', s: { low: 1, mid: 3, high: 1 } },
    { t: '💸 Não tenho orçamento disponível no momento.', s: { low: 4, mid: 1, high: 0 } },
  ]},
];

function sanitizar(perguntas) {
  if (!Array.isArray(perguntas) || perguntas.length < 1 || perguntas.length > 20) return { erro: 'Quantidade de perguntas inválida (1 a 20).' };
  const limpo = [];
  for (const p of perguntas) {
    if (!p || typeof p !== 'object') return { erro: 'Pergunta inválida.' };
    const q = String(p.q || '').trim().slice(0, 300);
    if (!q) return { erro: 'Há uma pergunta sem texto.' };
    const opts = [];
    for (const o of (Array.isArray(p.opts) ? p.opts : [])) {
      const t = String((o && o.t) || '').trim().slice(0, 140);
      if (!t) continue;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(9, Math.round(n))) : 0; };
      const op = { t, s: { low: num(o.s && o.s.low), mid: num(o.s && o.s.mid), high: num(o.s && o.s.high) } };
      if (o.destino) {
        if (!DESTINOS.includes(o.destino)) return { erro: 'Destino inválido numa opção da pergunta-chave.' };
        op.destino = o.destino;
      }
      opts.push(op);
    }
    if (p.ativo !== false && opts.length < 2) return { erro: `A pergunta "${q.slice(0, 40)}..." precisa de pelo menos 2 opções.` };
    limpo.push({
      id: String(p.id || '').trim().slice(0, 30) || ('p' + limpo.length),
      q, multi: !!p.multi, ativo: p.ativo !== false, opts,
    });
  }
  const chaves = limpo.filter((p) => p.opts.some((o) => o.destino));
  if (chaves.length !== 1) return { erro: 'Precisa existir exatamente 1 pergunta-chave (a da renda, com destinos).' };
  const ch = chaves[0];
  if (!ch.ativo) return { erro: 'A pergunta-chave da renda não pode ficar inativa.' };
  if (ch.multi) return { erro: 'A pergunta-chave da renda não pode ser de múltipla escolha.' };
  if (!ch.opts.every((o) => o.destino)) return { erro: 'Toda opção da pergunta-chave precisa de um destino (Comunidade/Imersão/WhatsApp).' };
  return { limpo };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  /* GET público — o quiz e o editor leem daqui */
  if (req.method === 'GET') {
    let salvas = null;
    try {
      const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE}&select=value&limit=1`, { headers: H });
      if (r.ok) {
        const rows = await r.json();
        if (rows[0] && rows[0].value) salvas = JSON.parse(rows[0].value);
      }
    } catch { /* usa padrão */ }
    const valida = salvas ? sanitizar(salvas) : null;
    if (valida && valida.limpo) return json({ ok: true, perguntas: valida.limpo, personalizado: true });
    return json({ ok: true, perguntas: PADRAO, personalizado: false });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok || !auth.admin) return json({ error: 'admin_only' }, 401);

  try {
    if (body.action === 'restaurar') {
      await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE}`, { method: 'DELETE', headers: H });
      return json({ ok: true });
    }
    const v = sanitizar(body.perguntas);
    if (v.erro) return json({ ok: false, error: v.erro });
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: CHAVE, value: JSON.stringify(v.limpo), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json({ ok: false, error: 'Erro ao salvar no banco.' });
    return json({ ok: true });
  } catch (e) {
    console.error('quiz-config:', e?.message || e);
    return json({ error: 'error' }, 500);
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-dash-token',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/quiz-config' };
