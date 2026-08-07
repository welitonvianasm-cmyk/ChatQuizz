/**
 * PRODUTOS — catálogo usado na conversão (Pós-Venda).
 *
 *   POST /api/produtos { token, action:'listar' }              → { ok, produtos }
 *   POST /api/produtos { token, action:'criar', nome, valor }  → { ok, produto }
 *
 * Qualquer usuário autenticado lista; criação também é liberada pra equipe
 * (o atendente cadastra o produto na hora de fechar a venda).
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-posvenda.sql no Supabase (tabela de produtos).';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  try {
    if (body.action === 'listar') {
      const r = await fetch(`${SB_URL}/rest/v1/produtos?select=id,nome,valor&order=nome.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, produtos: await r.json() });
    }

    if (body.action === 'criar') {
      const nome = String(body.nome || '').trim().slice(0, 120);
      const valor = Math.max(0, Number(body.valor) || 0);
      if (!nome) return json({ ok: false, error: 'Dê um nome ao produto.' });
      // evita duplicar pelo nome (ignorando maiúsculas)
      const dup = await fetch(`${SB_URL}/rest/v1/produtos?nome=ilike.${encodeURIComponent(nome)}&select=id,nome,valor&limit=1`, { headers: H });
      if (dup.ok) { const d = await dup.json(); if (d.length) return json({ ok: true, produto: d[0], jaExistia: true }); }
      const r = await fetch(`${SB_URL}/rest/v1/produtos`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ nome, valor }),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, produto: (await r.json())[0] });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('produtos:', e?.message || e);
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

export const config = { path: '/api/produtos' };
