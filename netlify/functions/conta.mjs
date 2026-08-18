/**
 * MINHA CONTA — escolha/troca de plano (Lite ou Completo) e domínio próprio.
 * Multi-tenant: ação escopada à conta do usuário autenticado (auth.contaId).
 * Só a dona/dono da conta ou quem tem funcao_adm pode mexer nisso.
 *
 *   { token, action:'salvar_plano', plano:'lite'|'completo' }  → { ok, plano }
 *
 *   { token, action:'salvar_dominio', dominio }   → { ok, dominio }
 *     Guarda o domínio como 'pendente' — só o painel master ativa, depois
 *     de conferir o DNS e adicionar o domínio no Netlify (não é automático).
 *   { token, action:'remover_dominio' }           → { ok }
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const PLANOS_VALIDOS = new Set(['lite', 'completo']);
const DOMINIO_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

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

    if (a === 'salvar_dominio') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora da conta pode configurar o domínio.' });
      const dominio = String(body.dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!DOMINIO_RE.test(dominio)) return json({ ok: false, error: 'Domínio inválido — use algo como quiz.suaempresa.com.br (sem https:// e sem barras).' });

      const rDup = await fetch(`${SB_URL}/rest/v1/contas?dominio_proprio=eq.${encodeURIComponent(dominio)}&id=neq.${contaId}&select=id&limit=1`, { headers: H });
      if (rDup.ok && (await rDup.json()).length) {
        return json({ ok: false, error: 'Esse domínio já está em uso por outra conta.' });
      }

      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${contaId}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ dominio_proprio: dominio, dominio_status: 'pendente', atualizado_em: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar o domínio.' });
      return json({ ok: true, dominio });
    }

    if (a === 'remover_dominio') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora da conta pode remover o domínio.' });
      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${contaId}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ dominio_proprio: null, dominio_status: null, atualizado_em: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao remover o domínio.' });
      return json({ ok: true });
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
