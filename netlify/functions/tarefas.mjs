/**
 * TAREFAS — lembretes (despertador) vinculados a um lead. Aparecem no
 * Cartão do Lead (seção "Tarefas") e, quando vencem, geram um alerta
 * automático na Central de Alertas (ver netlify/functions/tarefas-cron.mjs)
 * — nenhuma tela nova de notificação, o sino já existente cuida disso.
 *
 *   POST /api/tarefas { token, action:'listar', lead_ref }        → { ok, tarefas }
 *       sem lead_ref: devolve as tarefas abertas do atendente logado
 *       (admin vê todas as da conta)
 *   POST /api/tarefas { token, action:'criar', lead_ref, titulo, vencimento, atendente? }
 *       → { ok, tarefa }
 *   POST /api/tarefas { token, action:'concluir', id }   → { ok }
 *   POST /api/tarefas { token, action:'reabrir', id }    → { ok }
 *   POST /api/tarefas { token, action:'excluir', id }    → { ok }
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-tarefas.sql no Supabase (módulo Tarefas).';
const COLS = 'id,lead_ref,atendente,titulo,vencimento,concluida,criado_por,criado_em';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;
  const meuNome = auth.user.nome || '';

  try {
    if (body.action === 'listar') {
      const leadRef = String(body.lead_ref || '').trim();
      let filtro = `conta_id=eq.${contaId}`;
      if (leadRef) {
        filtro += `&lead_ref=eq.${encodeURIComponent(leadRef)}`;
      } else if (!auth.admin) {
        filtro += `&atendente=eq.${encodeURIComponent(meuNome)}&concluida=eq.false`;
      }
      const r = await fetch(`${SB_URL}/rest/v1/tarefas?${filtro}&select=${COLS}&order=concluida.asc,vencimento.asc&limit=300`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, tarefas: await r.json() });
    }

    if (body.action === 'criar') {
      const leadRef = String(body.lead_ref || '').trim();
      const titulo = String(body.titulo || '').trim().slice(0, 200);
      const vencimento = body.vencimento ? new Date(body.vencimento) : null;
      if (!leadRef || !titulo || !vencimento || isNaN(vencimento)) return json({ ok: false, error: 'Preencha o título e a data/hora.' });
      const atendente = String(body.atendente || meuNome || '').trim().slice(0, 120);
      const nova = {
        conta_id: contaId, lead_ref: leadRef, atendente, titulo,
        vencimento: vencimento.toISOString(), criado_por: meuNome,
      };
      const r = await fetch(`${SB_URL}/rest/v1/tarefas`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(nova),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const linha = (await r.json())[0];
      return json({ ok: true, tarefa: linha });
    }

    if (body.action === 'concluir' || body.action === 'reabrir') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/tarefas?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ concluida: body.action === 'concluir' }),
      });
      return json({ ok: r.ok });
    }

    if (body.action === 'excluir') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/tarefas?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('tarefas:', e?.message || e);
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

export const config = { path: '/api/tarefas' };
