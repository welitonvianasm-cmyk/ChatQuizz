/**
 * MINHA CONTA — escolha/troca de plano (Lite ou Completo).
 * Multi-tenant: ação escopada à conta do usuário autenticado (auth.contaId).
 * Só a dona/dono da conta ou quem tem funcao_adm pode trocar o plano.
 *
 *   { token, action:'salvar_plano', plano:'lite'|'completo' } → { ok, plano }
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const PLANOS_VALIDOS = new Set(['lite', 'completo']);

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const token = req.headers.get('x-dash-token') || body.token || '';
  const auth = await autenticarToken(token);
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  try {
    const a = body.action;

    if (a === 'salvar_plano') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora da conta pode trocar o plano.' });
      const plano = String(body.plano || '').trim().toLowerCase();
      if (!PLANOS_VALIDOS.has(plano)) return json({ ok: false, error: 'Plano inválido.' });

      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${contaId}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ plano, plano_definido_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar o plano.' });
      return json({ ok: true, plano });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('conta:', e?.message || e);
    return json({ error: 'error' }, 500);
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-dash-token',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/conta' };
