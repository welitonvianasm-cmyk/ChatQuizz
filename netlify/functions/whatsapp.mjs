/**
 * WHATSAPP (Evolution API) — status, conexão, toggles, envio e inbox.
 *
 *   { token, action:'status' }                   → { ok, configurada, estado, conversas, disparos }
 *   { token, action:'qr' }                       → { ok, qr }          (base64 pra conectar)
 *   { token, action:'toggles', conversas?, disparos? }  (só admin)
 *   { token, action:'send', telefone, texto, lead_ref? }
 *   { token, action:'inbox' }                    → { ok, conversas }   (agrupado por telefone)
 *   { token, action:'historico', telefone }      → { ok, mensagens }   (e marca como lidas)
 *
 * Env (preencher quando a VPS estiver no ar):
 *   EVOLUTION_URL      — ex.: https://api.suavitatisterapias.com.br
 *   EVOLUTION_KEY      — apikey global da Evolution
 *   EVOLUTION_INSTANCE — nome da instância (padrão: suavis)
 * Sem essas envs, tudo responde configurada:false e o painel cai no WhatsApp Web.
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const EV_URL = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EV_KEY = process.env.EVOLUTION_KEY || '';
const EV_INST = process.env.EVOLUTION_INSTANCE || 'suavis';
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';

const configurada = () => !!(EV_URL && EV_KEY);
const ev = (path, opts = {}) => fetch(`${EV_URL}${path}`, { ...opts, headers: { apikey: EV_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
export const soDigitos = (t) => String(t || '').replace(/\D/g, '');

/* toggles Conversas/Disparos guardados no funnel_config (valem pra todo o painel) */
async function lerToggles() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.wa_config&select=value&limit=1`, { headers: H });
    if (r.ok) { const rows = await r.json(); const v = rows[0] && JSON.parse(rows[0].value || '{}'); if (v && typeof v === 'object') return { conversas: !!v.conversas, disparos: !!v.disparos }; }
  } catch { /* padrão */ }
  return { conversas: false, disparos: false };
}
async function salvarToggles(t) {
  const body = JSON.stringify({ key: 'wa_config', value: JSON.stringify(t) });
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body,
  });
}

/* envia UMA mensagem de texto pela Evolution e grava no histórico */
export async function enviarWhats(telefone, texto, quem, lead_ref) {
  const tel = soDigitos(telefone);
  if (!tel || !texto) return { ok: false, error: 'telefone/mensagem vazios' };
  if (!configurada()) return { ok: false, error: 'WhatsApp não conectado (Evolution não configurada).' };
  const r = await ev(`/message/sendText/${EV_INST}`, {
    method: 'POST',
    body: JSON.stringify({ number: tel, text: texto }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: 'Evolution recusou o envio (' + r.status + ')' };
  const wa_id = (d && d.key && d.key.id) || '';
  try {
    await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ telefone: tel, lead_ref: lead_ref || '', direcao: 'out', texto: String(texto).slice(0, 4000), quem: quem || '', wa_id, lida: true }),
    });
  } catch { /* histórico é melhor-esforço */ }
  return { ok: true };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const quem = auth.user.nome || 'Equipe';

  try {
    const a = body.action;

    if (a === 'status') {
      const t = await lerToggles();
      let estado = 'nao_configurada';
      if (configurada()) {
        estado = 'desconectada';
        try {
          const r = await ev(`/instance/connectionState/${EV_INST}`);
          if (r.ok) { const d = await r.json(); estado = (d.instance && d.instance.state) === 'open' ? 'conectada' : 'desconectada'; }
        } catch { estado = 'erro'; }
      }
      return json({ ok: true, configurada: configurada(), estado, conversas: t.conversas, disparos: t.disparos });
    }

    if (a === 'qr') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora conecta o WhatsApp.' });
      if (!configurada()) return json({ ok: false, error: 'A Evolution API ainda não foi configurada (aguardando a VPS).' });
      // cria a instância se não existir e pede o QR
      try { await ev('/instance/create', { method: 'POST', body: JSON.stringify({ instanceName: EV_INST, qrcode: true, integration: 'WHATSAPP-BAILEYS' }) }); } catch { /* já existe */ }
      // garante o webhook: toda mensagem recebida chega ao CRM em tempo real
      const segredo = process.env.WA_WEBHOOK_SECRET || '';
      if (segredo) {
        try {
          await ev(`/webhook/set/${EV_INST}`, {
            method: 'POST',
            body: JSON.stringify({ webhook: { enabled: true, url: `https://quiz-suavitatis.netlify.app/api/wa-webhook?t=${segredo}`, events: ['MESSAGES_UPSERT'], base64: false, byEvents: false } }),
          });
        } catch { /* reconfigura no próximo QR */ }
      }
      const r = await ev(`/instance/connect/${EV_INST}`);
      const d = await r.json().catch(() => ({}));
      const qr = (d && (d.base64 || (d.qrcode && d.qrcode.base64))) || '';
      if (!qr) return json({ ok: false, error: 'QR indisponível agora (a instância pode já estar conectada).' });
      return json({ ok: true, qr });
    }

    if (a === 'toggles') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora altera os controles do WhatsApp.' });
      const t = await lerToggles();
      if ('conversas' in body) t.conversas = !!body.conversas;
      if ('disparos' in body) t.disparos = !!body.disparos;
      await salvarToggles(t);
      return json({ ok: true, conversas: t.conversas, disparos: t.disparos });
    }

    if (a === 'send') {
      const t = await lerToggles();
      if (!t.conversas) return json({ ok: false, error: 'As Conversas estão desativadas nas configurações do WhatsApp.' });
      const r = await enviarWhats(body.telefone, String(body.texto || '').trim(), quem, body.lead_ref);
      return json(r);
    }

    if (a === 'inbox') {
      const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?select=telefone,lead_ref,direcao,texto,lida,criado_em&order=criado_em.desc&limit=1200`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const msgs = await r.json();
      const conv = new Map();
      msgs.forEach((m) => {
        if (!conv.has(m.telefone)) conv.set(m.telefone, { telefone: m.telefone, lead_ref: m.lead_ref || '', ultima: m.texto, quando: m.criado_em, nao_lidas: 0 });
        const c = conv.get(m.telefone);
        if (!c.lead_ref && m.lead_ref) c.lead_ref = m.lead_ref;
        if (m.direcao === 'in' && !m.lida) c.nao_lidas++;
      });
      return json({ ok: true, conversas: [...conv.values()] });
    }

    if (a === 'historico') {
      const tel = soDigitos(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?telefone=eq.${tel}&select=direcao,texto,quem,criado_em&order=criado_em.asc&limit=500`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const mensagens = await r.json();
      // abriu a conversa → recebidas viram lidas
      fetch(`${SB_URL}/rest/v1/wa_mensagens?telefone=eq.${tel}&direcao=eq.in&lida=eq.false`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ lida: true }),
      }).catch(() => {});
      return json({ ok: true, mensagens });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('whatsapp:', e?.message || e);
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

export const config = { path: '/api/whatsapp' };
