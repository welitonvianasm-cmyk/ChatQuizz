/**
 * Config do funil (painel admin). Hoje guarda o "closer prioritário":
 * quando setado, TODOS os leads da trilha premium vão pra esse closer
 * (override do sorteio ponderado). Vazio = sorteio normal.
 *
 * Protegido pelo DASHBOARD_TOKEN (mesmo do /api/metrics). Lê/grava na tabela
 * funnel_config do projeto dedicado, com a service_role (backend).
 *   GET  /api/config            → { ok, forced, vendedores:[{nome,eventTypeId}] }
 *   POST /api/config {value}    → grava closer_prioritario (eventTypeId ou '')
 */
import { vendedoresDaTrilha } from './agenda.mjs';
import { temConfig, autenticar } from '../_tokens.mjs';

const SUPABASE_URL = (process.env.SUPABASE_DIAG_URL || 'https://aktktxizmpwckvxbdjzf.supabase.co').replace(/\/+$/, '');

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  if (!temConfig()) return json({ error: 'DASHBOARD_TOKEN not configured' }, 503);
  const KEY = process.env.SUPABASE_DIAG_SERVICE;
  if (!KEY) return json({ error: 'SUPABASE_DIAG_SERVICE not configured' }, 500);

  let body = {};
  try { if (req.method === 'POST') body = await req.json(); } catch { /* sem body */ }
  const token = req.headers.get('x-dash-token') || body.token || '';
  const acesso = await autenticar(token);
  if (!acesso.ok) return json({ error: 'unauthorized' }, 401);

  const vendedores = vendedoresDaTrilha('premium').map((v) => ({ nome: v.nome, eventTypeId: +v.eventTypeId }));
  const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` };

  try {
    if (req.method === 'POST') {
      const value = String(body.value ?? '').trim().slice(0, 20);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/funnel_config?on_conflict=key`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'closer_prioritario', value, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) { console.error('config set:', r.status, await r.text().catch(() => '')); return json({ ok: false, error: 'save failed' }, 500); }
      return json({ ok: true, forced: value, vendedores });
    }
    // GET → lê
    const r = await fetch(`${SUPABASE_URL}/rest/v1/funnel_config?key=eq.closer_prioritario&select=value&limit=1`, { headers: auth });
    const rows = r.ok ? await r.json() : [];
    const forced = (rows && rows[0] && rows[0].value) ? String(rows[0].value) : '';
    return json({ ok: true, forced, vendedores });
  } catch (err) {
    console.error('config error:', err?.message || err);
    return json({ ok: false, error: 'error' }, 500);
  }
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

export const config = { path: '/api/config' };
