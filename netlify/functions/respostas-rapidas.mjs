/**
 * RESPOSTAS RÁPIDAS — catálogo de textos prontos pro atendente usar nas
 * Conversas: digita "/atalho" no campo de mensagem e completa sozinho.
 * Qualquer usuário logado da conta pode gerenciar (não é admin-only —
 * é uma ferramenta do dia a dia do time, não uma configuração sensível).
 *
 *   POST /api/respostas-rapidas { token, action:'listar' }                           → { ok, respostas }
 *   POST /api/respostas-rapidas { token, action:'criar', atalho, titulo, conteudo }   → { ok, resposta }
 *   POST /api/respostas-rapidas { token, action:'editar', id, atalho?, titulo?, conteudo? } → { ok }
 *   POST /api/respostas-rapidas { token, action:'excluir', id }                       → { ok }
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-respostas-rapidas.sql no Supabase (módulo Respostas Rápidas).';

function normalizarAtalho(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/^\/+/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);
}

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

  try {
    if (body.action === 'listar') {
      const r = await fetch(`${SB_URL}/rest/v1/respostas_rapidas?conta_id=eq.${contaId}&select=id,atalho,titulo,conteudo&order=atalho.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, respostas: await r.json() });
    }

    if (body.action === 'criar') {
      const atalho = normalizarAtalho(body.atalho);
      const conteudo = String(body.conteudo || '').trim().slice(0, 2000);
      if (!atalho || !conteudo) return json({ ok: false, error: 'Informe o atalho e o conteúdo.' });
      const titulo = String(body.titulo || '').trim().slice(0, 80) || atalho;
      const r = await fetch(`${SB_URL}/rest/v1/respostas_rapidas`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ conta_id: contaId, atalho, titulo, conteudo }),
      });
      if (!r.ok) {
        const errText = await r.text();
        if (errText.includes('duplicate') || errText.includes('unique')) return json({ ok: false, error: 'Já existe uma resposta rápida com esse atalho.' });
        return json({ ok: false, error: AVISO_SQL });
      }
      return json({ ok: true, resposta: (await r.json())[0] });
    }

    if (body.action === 'editar') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const patch = {};
      if (body.atalho !== undefined) {
        const atalho = normalizarAtalho(body.atalho);
        if (!atalho) return json({ ok: false, error: 'Atalho inválido.' });
        patch.atalho = atalho;
      }
      if (body.titulo !== undefined) patch.titulo = String(body.titulo).trim().slice(0, 80);
      if (body.conteudo !== undefined) patch.conteudo = String(body.conteudo).trim().slice(0, 2000);
      if (!Object.keys(patch).length) return json({ ok: false, error: 'nada para alterar' });
      const r = await fetch(`${SB_URL}/rest/v1/respostas_rapidas?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const errText = await r.text();
        if (errText.includes('duplicate') || errText.includes('unique')) return json({ ok: false, error: 'Já existe uma resposta rápida com esse atalho.' });
        return json({ ok: false, error: AVISO_SQL });
      }
      return json({ ok: true });
    }

    if (body.action === 'excluir') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/respostas_rapidas?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('respostas-rapidas:', e?.message || e);
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

export const config = { path: '/api/respostas-rapidas' };
