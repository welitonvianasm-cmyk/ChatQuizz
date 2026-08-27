/**
 * WHATSAPP (Evolution API) — status, conexão, toggles, envio e inbox.
 *
 *   { token, action:'status' }                   → { ok, configurada, estado, conversas, disparos }
 *   { token, action:'qr' }                       → { ok, qr }          (base64 pra conectar)
 *   { token, action:'toggles', conversas?, disparos? }  (só admin)
 *   { token, action:'send', telefone, texto, lead_ref? }
 *   { token, action:'inbox' }                    → { ok, conversas }   (agrupado por telefone)
 *   { token, action:'historico', telefone }      → { ok, mensagens }   (e marca como lidas)
 *   { token, action:'excluir_conversa', telefone } → { ok }   (apaga o histórico; some da lista e, se voltar a mandar mensagem, começa do zero)
 *
 * Env (preencher quando o servidor da Evolution estiver no ar):
 *   EVOLUTION_URL      — ex.: https://sua-evolution-api.com
 *   EVOLUTION_KEY      — apikey global da Evolution
 *   EVOLUTION_INSTANCE — nome da instância (padrão: quizzhub)
 * Sem essas envs, tudo responde configurada:false e o painel cai no WhatsApp Web.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const EV_URL = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EV_KEY = process.env.EVOLUTION_KEY || '';
const EV_INST = process.env.EVOLUTION_INSTANCE || 'quizzhub';
// URL pública do site — Netlify preenche isso automaticamente (URL de produção)
const SITE_URL = (process.env.URL || '').replace(/\/+$/, '');
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';

const configurada = () => !!(EV_URL && EV_KEY);
const ev = (path, opts = {}) => fetch(`${EV_URL}${path}`, { ...opts, headers: { apikey: EV_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
export const soDigitos = (t) => String(t || '').replace(/\D/g, '');
/* normaliza número BR pro formato canônico 55+DDD+9 dígitos — o WhatsApp às
   vezes reporta o mesmo contato com ou sem o 9º dígito do celular, o que sem
   isso vira dois "telefone" diferentes (conversa duplicada na lista). Mesma
   função em wa-webhook.mjs/lead-admin.mjs/webhook-pagamento.mjs. */
export function normalizarTelefoneBR(raw) {
  const d = soDigitos(raw);
  if (!d) return '';
  let resto;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) resto = d.slice(2);
  else if (d.length === 10 || d.length === 11) resto = d;
  else return d;
  const ddd = resto.slice(0, 2);
  let numero = resto.slice(2);
  if (numero.length === 8) numero = '9' + numero;
  return '55' + ddd + numero;
}
/* extrai o texto de erro real da Evolution — o formato varia (string, array de
   strings, ou objeto aninhado em response.message) — sem isso, todo erro virava
   só "recusou (400)" ou literalmente "[object Object]", sem dizer o motivo */
function textoDe(m) {
  if (m == null) return null;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((x) => textoDe(x) || JSON.stringify(x)).join('; ');
  if (typeof m === 'object') return textoDe(m.message) || JSON.stringify(m);
  return String(m);
}
export function mensagemErroEvolution(d, status) {
  const detalhe = textoDe(d && (d.response?.message ?? d.message ?? d.error));
  return 'Evolution recusou o envio (' + status + ')' + (detalhe ? ': ' + detalhe : '');
}

/* toggles Conversas/Disparos guardados no funnel_config (por conta) */
async function lerToggles(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.wa_config&select=value&limit=1`, { headers: H });
    if (r.ok) { const rows = await r.json(); const v = rows[0] && JSON.parse(rows[0].value || '{}'); if (v && typeof v === 'object') return { conversas: !!v.conversas, disparos: !!v.disparos }; }
  } catch { /* padrão */ }
  return { conversas: false, disparos: false };
}
async function salvarToggles(contaId, t) {
  const body = JSON.stringify({ conta_id: contaId, key: 'wa_config', value: JSON.stringify(t) });
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body,
  });
}

/* envia UMA mensagem de texto pela Evolution e grava no histórico.
   NOTA: a instância Evolution (EV_URL/EV_KEY/EV_INST) ainda é global —
   todas as contas compartilham o mesmo número de WhatsApp até virar uma
   conexão por conta (mesmo padrão já usado pro Cal.com/MentoriaHub). */
export async function enviarWhats(contaId, telefone, texto, quem, lead_ref) {
  const tel = normalizarTelefoneBR(telefone);
  if (!tel || !texto) return { ok: false, error: 'telefone/mensagem vazios' };
  if (!configurada()) return { ok: false, error: 'WhatsApp não conectado (Evolution não configurada).' };
  const r = await ev(`/message/sendText/${EV_INST}`, {
    method: 'POST',
    body: JSON.stringify({ number: tel, text: texto }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: mensagemErroEvolution(d, r.status) };
  const wa_id = (d && d.key && d.key.id) || '';
  try {
    await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ conta_id: contaId, telefone: tel, lead_ref: lead_ref || '', direcao: 'out', texto: String(texto).slice(0, 4000), quem: quem || '', wa_id, lida: true }),
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
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const quem = auth.user.nome || 'Equipe';
  const contaId = auth.contaId;

  try {
    const a = body.action;

    if (a === 'status') {
      const t = await lerToggles(contaId);
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
      if (segredo && SITE_URL) {
        try {
          await ev(`/webhook/set/${EV_INST}`, {
            method: 'POST',
            body: JSON.stringify({ webhook: { enabled: true, url: `${SITE_URL}/api/wa-webhook?t=${segredo}`, events: ['MESSAGES_UPSERT'], base64: false, byEvents: false } }),
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
      const t = await lerToggles(contaId);
      if ('conversas' in body) t.conversas = !!body.conversas;
      if ('disparos' in body) t.disparos = !!body.disparos;
      await salvarToggles(contaId, t);
      return json({ ok: true, conversas: t.conversas, disparos: t.disparos });
    }

    if (a === 'send') {
      const t = await lerToggles(contaId);
      if (!t.conversas) return json({ ok: false, error: 'As Conversas estão desativadas nas configurações do WhatsApp.' });
      const r = await enviarWhats(contaId, body.telefone, String(body.texto || '').trim(), quem, body.lead_ref);
      return json(r);
    }

    if (a === 'inbox') {
      let colsInbox = 'telefone,lead_ref,direcao,texto,lida,criado_em,push_name';
      let r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&select=${colsInbox}&order=criado_em.desc&limit=1200`, { headers: H });
      if (!r.ok) {
        colsInbox = 'telefone,lead_ref,direcao,texto,lida,criado_em';   // falta rodar setup-wa-nome-contato.sql
        r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&select=${colsInbox}&order=criado_em.desc&limit=1200`, { headers: H });
      }
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const msgs = await r.json();
      const conv = new Map();
      msgs.forEach((m) => {
        if (!conv.has(m.telefone)) conv.set(m.telefone, { telefone: m.telefone, lead_ref: m.lead_ref || '', ultima: m.texto, quando: m.criado_em, nao_lidas: 0, pushName: m.push_name || '' });
        const c = conv.get(m.telefone);
        if (!c.lead_ref && m.lead_ref) c.lead_ref = m.lead_ref;
        if (!c.pushName && m.push_name) c.pushName = m.push_name;
        if (m.direcao === 'in' && !m.lida) c.nao_lidas++;
      });
      return json({ ok: true, conversas: [...conv.values()] });
    }

    if (a === 'historico') {
      const tel = normalizarTelefoneBR(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&telefone=eq.${tel}&select=direcao,texto,quem,criado_em&order=criado_em.asc&limit=500`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const mensagens = await r.json();
      // abriu a conversa → recebidas viram lidas
      fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&telefone=eq.${tel}&direcao=eq.in&lida=eq.false`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ lida: true }),
      }).catch(() => {});
      return json({ ok: true, mensagens });
    }

    if (a === 'excluir_conversa') {
      // propositalmente NÃO usa normalizarTelefoneBR aqui: o telefone chega
      // exatamente como está gravado em wa_mensagens (a lista/inbox mostra o
      // valor cru da coluna). Uma conversa duplicada pelo bug do 9º dígito
      // (ex.: 556796068167 vs 5567996068167) tem DUAS linhas com telefone
      // diferente pro mesmo contato — normalizar aqui faria o "errado" virar
      // o "certo" antes de comparar, e a exclusão nunca acertaria a linha
      // realmente duplicada (excluía sempre a outra, a certa, por engano).
      const tel = soDigitos(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&telefone=eq.${tel}`, {
        method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' },
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao excluir a conversa.' });
      return json({ ok: true });
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
