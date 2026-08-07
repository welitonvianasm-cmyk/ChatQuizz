/**
 * AUTOMAÇÕES — mensagens automáticas 100% editáveis (moram no banco).
 *
 *   { token, action:'listar' }                                    → { ok, automacoes }
 *   { token, action:'criar',  nome, gatilho, mensagem }           (admin)
 *   { token, action:'editar', id, nome?, gatilho?, mensagem?, ativa? }  (admin)
 *   { token, action:'excluir', id }                               (admin)
 *
 * Gatilhos: 'reuniao_1h' (lembrete 1h antes da reunião) | 'manual'.
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';
const GATILHOS = ['manual', 'reuniao_1h'];

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  try {
    const a = body.action;
    const id = Number(body.id) || 0;

    if (a === 'listar') {
      const r = await fetch(`${SB_URL}/rest/v1/automacoes?select=id,nome,gatilho,mensagem,ativa,criado_em&order=criado_em.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, automacoes: await r.json() });
    }

    if (!auth.admin) return json({ ok: false, error: 'Somente a administradora gerencia as automações.' });

    if (a === 'criar' || a === 'editar') {
      const patch = {};
      if ('nome' in body || a === 'criar') {
        patch.nome = String(body.nome || '').trim().slice(0, 120);
        if (!patch.nome) return json({ ok: false, error: 'Dê um nome à automação.' });
      }
      if ('gatilho' in body || a === 'criar') {
        patch.gatilho = String(body.gatilho || 'manual').trim();
        if (!GATILHOS.includes(patch.gatilho)) return json({ ok: false, error: 'gatilho inválido' });
      }
      if ('mensagem' in body || a === 'criar') patch.mensagem = String(body.mensagem || '').slice(0, 3000);
      if ('ativa' in body) patch.ativa = !!body.ativa;
      const r = a === 'criar'
        ? await fetch(`${SB_URL}/rest/v1/automacoes`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
        : await fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true });
    }

    if (a === 'excluir') {
      const r = await fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('automacoes:', e?.message || e);
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

export const config = { path: '/api/automacoes' };
