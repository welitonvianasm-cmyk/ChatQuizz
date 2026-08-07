/**
 * CENTRAL DE ALERTAS — notificações internas do CRM.
 *
 *   POST /api/alertas { token, action:'listar' }   → { ok, alertas }
 *       administradora vê TODOS; atendente vê só os alertas dele (pelo nome)
 *   POST /api/alertas { token, action:'ok', id }   → { ok }  (marca como lido)
 *
 * A criação dos alertas é automática (feita pelo lead-admin quando a
 * presença de um lead é registrada) — nada é cadastrado manualmente aqui.
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'A tabela de alertas ainda não existe. Rode o setup-alertas.sql no Supabase (SQL Editor).';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  const meuNome = auth.user.nome || '';

  try {
    if (body.action === 'listar') {
      // atendente vê os alertas DELE + os "de todos" (lead sem responsável → atendente vazio)
      const filtro = auth.admin ? '' : `&or=(atendente.eq.${encodeURIComponent(meuNome)},atendente.eq.)`;
      const r = await fetch(`${SB_URL}/rest/v1/alertas?select=id,lead_ref,lead_nome,atendente,tipo,descricao,data_hora,status,criado_em&order=criado_em.desc&limit=150${filtro}`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, alertas: await r.json() });
    }

    if (body.action === 'ok') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const filtro = auth.admin ? '' : `&or=(atendente.eq.${encodeURIComponent(meuNome)},atendente.eq.)`;
      const r = await fetch(`${SB_URL}/rest/v1/alertas?id=eq.${id}${filtro}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'lido' }),
      });
      return json({ ok: r.ok });
    }

    /* alerta "de todos" ganha um dono (quando o lead é atribuído pelo próprio alerta) */
    if (body.action === 'atribuir') {
      const id = Number(body.id) || 0;
      const atendente = String(body.atendente || '').trim().slice(0, 120);
      if (!id || !atendente) return json({ ok: false, error: 'dados incompletos' });
      const r = await fetch(`${SB_URL}/rest/v1/alertas?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ atendente }),
      });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('alertas:', e?.message || e);
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

export const config = { path: '/api/alertas' };
