/**
 * PAINEL MASTER — gestão de TODAS as contas (assinantes) do QuizzHub.
 * Superfície separada do dashboard.html de cada conta: autenticada por uma
 * senha única (SUPERADMIN_TOKEN, env var), que só o dono do QuizzHub tem —
 * nunca exposta a assinantes comuns.
 *
 *   { token, action:'listar' }                              → { ok, contas }
 *   { token, action:'atualizar', id, plano?, status? }       → { ok }
 */
import { timingSafeEqual } from 'node:crypto';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const PLANOS_VALIDOS = new Set(['lite', 'completo']);
const STATUS_VALIDOS = new Set(['ativa', 'suspensa']);

function autenticarMaster(token) {
  const esperado = process.env.SUPERADMIN_TOKEN || '';
  if (!esperado) return false;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!process.env.SUPERADMIN_TOKEN) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  if (!autenticarMaster(body.token)) return json({ error: 'unauthorized' }, 401);

  try {
    const a = body.action;

    if (a === 'listar') {
      const rc = await fetch(
        `${SB_URL}/rest/v1/contas?select=id,nome,subdominio,email_contato,plano,status,criado_em,plano_definido_em&order=criado_em.asc`,
        { headers: H }
      );
      if (!rc.ok) return json({ ok: false, error: 'Erro ao carregar as contas.' });
      const contas = await rc.json();

      // contagem de usuários por conta (número pequeno de tenants — 1 query só, sem paginação)
      const ru = await fetch(`${SB_URL}/rest/v1/usuarios?select=conta_id`, { headers: H });
      const porConta = new Map();
      if (ru.ok) {
        for (const u of await ru.json()) porConta.set(u.conta_id, (porConta.get(u.conta_id) || 0) + 1);
      }
      contas.forEach((c) => { c.totalUsuarios = porConta.get(c.id) || 0; });

      return json({ ok: true, contas });
    }

    if (a === 'atualizar') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'Conta inválida.' });
      const patch = { atualizado_em: new Date().toISOString() };
      if ('plano' in body) {
        const plano = String(body.plano || '').trim().toLowerCase();
        if (!PLANOS_VALIDOS.has(plano)) return json({ ok: false, error: 'Plano inválido.' });
        patch.plano = plano;
        patch.plano_definido_em = new Date().toISOString();
      }
      if ('status' in body) {
        const status = String(body.status || '').trim().toLowerCase();
        if (!STATUS_VALIDOS.has(status)) return json({ ok: false, error: 'Status inválido.' });
        patch.status = status;
      }
      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar.' });
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('master:', e?.message || e);
    return json({ error: 'error' }, 500);
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/master' };
