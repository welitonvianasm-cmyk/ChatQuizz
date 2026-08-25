/**
 * CONFIGURAÇÃO DOS KPIs PERSONALIZADOS DA VISÃO GERAL — quais perguntas do
 * quiz viram painel extra, e se o grupo de Agendamento (opcional) aparece.
 * Multi-tenant: cada conta tem a própria (funnel_config escopado por conta_id).
 *
 *   GET  /api/kpis-config { token }                → { ok, agendamentoAtivo, perguntasAtivas }
 *   POST /api/kpis-config { token, agendamentoAtivo, perguntasAtivas } → salva (SÓ administradora)
 *   POST /api/kpis-config { token, action:'restaurar' } → volta ao padrão
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE = 'kpis_geral';
const PADRAO = { agendamentoAtivo: true, perguntasAtivas: [] };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  if (req.method === 'GET') {
    const config = await ler(contaId);
    return json({ ok: true, ...config });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);
  if (!auth.admin) return json({ error: 'admin_only' }, 401);

  try {
    if (body.action === 'restaurar') {
      await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE}`, { method: 'DELETE', headers: H });
      return json({ ok: true, ...PADRAO });
    }
    const limpo = {
      agendamentoAtivo: !!body.agendamentoAtivo,
      perguntasAtivas: Array.isArray(body.perguntasAtivas) ? body.perguntasAtivas.map((id) => String(id).slice(0, 60)).slice(0, 30) : [],
    };
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ conta_id: contaId, key: CHAVE, value: JSON.stringify(limpo), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json({ ok: false, error: 'Erro ao salvar no banco.' });
    return json({ ok: true, ...limpo });
  } catch (e) {
    console.error('kpis-config:', e?.message || e);
    return json({ error: 'error' }, 500);
  }
};

async function ler(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      if (rows[0] && rows[0].value) return { ...PADRAO, ...JSON.parse(rows[0].value) };
    }
  } catch { /* usa padrão */ }
  return { ...PADRAO };
}

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

export const config = { path: '/api/kpis-config' };
