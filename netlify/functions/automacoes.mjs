/**
 * AUTOMAÇÕES — mensagens automáticas 100% editáveis (moram no banco).
 *
 *   { token, action:'listar' }                                    → { ok, automacoes }
 *   { token, action:'criar',  nome, gatilho, mensagem }           (admin)
 *   { token, action:'editar', id, nome?, gatilho?, mensagem?, ativa? }  (admin)
 *   { token, action:'excluir', id }                               (admin)
 *
 * Gatilhos: 'reuniao_1h' (lembrete 1h antes da reunião) | 'lead_vip' (alerta
 * de lead prioritário, dispara quando o qualificador computado do lead bate
 * com `qualificador_alvo`; a mensagem vai pro número de staff em `destino`,
 * não pro lead) | 'manual'.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';
const GATILHOS = ['manual', 'reuniao_1h', 'lead_vip'];

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  try {
    const a = body.action;
    const id = Number(body.id) || 0;

    if (a === 'listar') {
      const r = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&select=id,nome,gatilho,mensagem,ativa,destino,qualificador_alvo,criado_em&order=criado_em.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      let automacoes = await r.json();
      // número de staff é dado sensível — só a administradora vê de verdade
      if (!auth.admin) automacoes = automacoes.map((am) => ({ ...am, destino: am.destino ? '••••••' : '' }));
      return json({ ok: true, automacoes });
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
      if ('destino' in body) patch.destino = String(body.destino || '').replace(/\D/g, '').slice(0, 20);
      if ('qualificador_alvo' in body) patch.qualificador_alvo = String(body.qualificador_alvo || '').trim().slice(0, 40);
      if ('ativa' in body) patch.ativa = !!body.ativa;
      if (a === 'criar') patch.conta_id = contaId;
      const r = a === 'criar'
        ? await fetch(`${SB_URL}/rest/v1/automacoes`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
        : await fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true });
    }

    if (a === 'excluir') {
      const r = await fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
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
