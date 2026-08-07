/**
 * DISPAROS AGENDADOS — fila de envios do WhatsApp.
 *
 *   { token, action:'listar', status? }                       → { ok, disparos }
 *   { token, action:'criar', contatos:[{telefone,nome,lead_ref}], enviar_em, mensagem }
 *   { token, action:'cancelar', id }      (só disparo pendente)
 *
 * Quem executa a fila é o cron (wa-cron.mjs, a cada 5 minutos), e SÓ com o
 * toggle Disparos ativado. Lembretes de reunião também caem nesta tabela,
 * criados automaticamente pelo cron a partir do módulo Reuniões.
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';

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

    if (a === 'listar') {
      const st = ['pendente', 'enviado', 'falhou'].includes(body.status) ? `&status=eq.${body.status}` : '';
      const r = await fetch(`${SB_URL}/rest/v1/disparos?select=id,telefone,nome,lead_ref,mensagem,enviar_em,status,erro,origem,enviado_em&order=enviar_em.desc&limit=400${st}`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, disparos: await r.json() });
    }

    if (a === 'criar') {
      const quando = new Date(body.enviar_em || '');
      if (isNaN(quando)) return json({ ok: false, error: 'Data/horário do envio inválidos.' });
      const mensagem = String(body.mensagem || '').trim().slice(0, 3000);
      if (!mensagem) return json({ ok: false, error: 'Escreva a mensagem.' });
      const contatos = (Array.isArray(body.contatos) ? body.contatos : []).slice(0, 200)
        .map((c) => ({ telefone: String((c && c.telefone) || '').replace(/\D/g, ''), nome: String((c && c.nome) || '').slice(0, 120), lead_ref: String((c && c.lead_ref) || '') }))
        .filter((c) => c.telefone);
      if (!contatos.length) return json({ ok: false, error: 'Escolha pelo menos um contato com telefone.' });
      // {{nome}} vira o primeiro nome de cada contato já na criação
      const linhas = contatos.map((c) => ({
        ...c,
        mensagem: mensagem.replaceAll('{{nome}}', String(c.nome || '').trim().split(/\s+/)[0] || 'tudo bem'),
        enviar_em: quando.toISOString(), status: 'pendente', origem: 'manual',
      }));
      const r = await fetch(`${SB_URL}/rest/v1/disparos`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(linhas),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, criados: contatos.length });
    }

    if (a === 'cancelar') {
      const id = Number(body.id) || 0;
      const r = await fetch(`${SB_URL}/rest/v1/disparos?id=eq.${id}&status=eq.pendente`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('disparos:', e?.message || e);
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

export const config = { path: '/api/disparos' };
