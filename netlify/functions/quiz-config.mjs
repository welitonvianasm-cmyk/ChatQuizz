/**
 * CONFIGURAÇÃO DO QUIZ — editável pelo painel (Editor do Quiz). Multi-tenant:
 * cada conta tem seu próprio documento (funnel_config escopado por conta_id).
 *
 *   GET  /api/quiz-config                       → { ok, ...documento, personalizado }
 *        (o quiz público resolve a conta pelo subdomínio; o painel, autenticado,
 *        manda x-dash-token e resolve a conta pelo login — os dois usam o mesmo GET)
 *   POST /api/quiz-config { token, ...documento } → salva (SÓ administradora)
 *   POST /api/quiz-config { token, action:'restaurar' } → volta ao padrão
 *
 * O documento inteiro (perguntas + qualificadores + níveis + resultados +
 * roteamento) é validado como uma unidade — ver netlify/_quiz.mjs.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { resolverContaPorHost } from '../_tenant.mjs';
import { PADRAO, sanitizar, carregarConfigPublicada } from '../_quiz.mjs';
import { obterCalcomApiKey, obterConexaoMentoriaHub } from '../_conexoes.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE = 'quiz_perguntas';
// mesma checagem "leve" que o painel usa pra decidir se pode oferecer o
// roteamento WhatsApp — não confirma sessão *conectada*, só que as
// credenciais da Evolution existem (checagem de estado ao vivo é cara
// demais pra rodar em toda carga pública do quiz).
const whatsappConectado = () => !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_KEY);

/* GET é usado tanto pelo quiz público (sem login — resolve pelo
   subdomínio) quanto pelo painel autenticado (Editor do Quiz — resolve
   pelo login, se vier x-dash-token). */
async function resolverContaGet(req) {
  const token = req.headers.get('x-dash-token') || '';
  if (token) {
    const auth = await autenticarToken(token);
    if (auth.ok) return auth.contaId;
  }
  return resolverContaPorHost(req);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  if (req.method === 'GET') {
    const contaId = await resolverContaGet(req);
    if (!contaId) return json({ error: 'Conta não encontrada' }, 404);
    const { doc, personalizado } = await carregarConfigPublicada(SB_URL, H, contaId);
    const calcomConectado = !!(await obterCalcomApiKey(contaId));
    const mentoriahubConectado = !!(await obterConexaoMentoriaHub(contaId));
    return json({ ok: true, ...doc, personalizado, whatsappConectado: whatsappConectado(), calcomConectado, mentoriahubConectado });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok || !auth.admin) return json({ error: 'admin_only' }, 401);
  const contaId = auth.contaId;

  try {
    if (body.action === 'restaurar') {
      await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE}`, { method: 'DELETE', headers: H });
      return json({ ok: true, ...PADRAO });
    }
    const v = sanitizar(body);
    if (v.erro) return json({ ok: false, error: v.erro });
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ conta_id: contaId, key: CHAVE, value: JSON.stringify(v.limpo), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json({ ok: false, error: 'Erro ao salvar no banco.' });
    return json({ ok: true, ...v.limpo });
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
