/**
 * WHATSAPP (Evolution API) — status, instâncias (números conectados por
 * conta), toggles, envio e inbox.
 *
 *   { token, action:'status' }                        → { ok, configurada, estado, conversas, disparos }
 *   { token, action:'instancias_listar' }              → { ok, instancias }  (com estado ao vivo de cada uma)
 *   { token, action:'instancias_criar', rotulo }       → { ok, instancia }   (só admin)
 *   { token, action:'instancias_qr', id }              → { ok, qr }          (só admin)
 *   { token, action:'instancias_definir_padrao', id }  → { ok }              (só admin)
 *   { token, action:'instancias_remover', id }         → { ok }              (só admin)
 *   { token, action:'toggles', conversas?, disparos? }  (só admin)
 *   { token, action:'send', telefone, texto, lead_ref? }
 *   { token, action:'inbox' }                    → { ok, conversas }   (agrupado por telefone)
 *   { token, action:'historico', telefone }      → { ok, mensagens, iaPausada }   (e marca como lidas)
 *   { token, action:'excluir_conversa', telefone } → { ok }   (apaga o histórico; some da lista e, se voltar a mandar mensagem, começa do zero)
 *   { token, action:'ia_estado', telefone }      → { ok, iaPausada }
 *   { token, action:'ia_pausar', telefone }      → { ok }   (Agente IA para de responder esse lead)
 *   { token, action:'ia_retomar', telefone }     → { ok }   (volta a responder a partir da PRÓXIMA mensagem nova)
 *
 * Env:
 *   EVOLUTION_URL/EVOLUTION_KEY — servidor Evolution (compartilhado; cada conta
 *   conecta sua(s) própria(s) instância(s) nele — ver netlify/_evolution.mjs)
 * Sem essas envs, tudo responde configurada:false e o painel cai no WhatsApp Web.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import {
  configurada, soDigitos, normalizarTelefoneBR, mensagemErroEvolution,
  listarInstancias, criarInstancia, qrInstancia, statusInstancia,
  removerInstancia, definirPadrao, atualizarEstadoLocal, obterInstanciaDaConversa,
  enviarTexto,
} from '../_evolution.mjs';
import { lerEstadoConversa, definirPausaConversa } from '../_agenteIa.mjs';

export { soDigitos, normalizarTelefoneBR, mensagemErroEvolution };   // outros módulos ainda importam daqui

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';

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

/* envia UMA mensagem de texto pela instância certa da conversa (mesmo número
   que o lead já está falando) e grava no histórico. */
export async function enviarWhats(contaId, telefone, texto, quem, lead_ref) {
  const tel = normalizarTelefoneBR(telefone);
  if (!tel || !texto) return { ok: false, error: 'telefone/mensagem vazios' };
  const inst = await obterInstanciaDaConversa(contaId, tel);
  if (!inst) return { ok: false, error: 'Nenhum WhatsApp conectado nesta conta ainda (Conexões → WhatsApp).' };
  const r = await enviarTexto(inst.nome_instancia, tel, texto);
  if (!r.ok) return r;
  try {
    await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ conta_id: contaId, telefone: tel, lead_ref: lead_ref || '', direcao: 'out', texto: String(texto).slice(0, 4000), quem: quem || '', wa_id: r.wa_id || '', lida: true, instancia: inst.nome_instancia }),
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
      const instancias = await listarInstancias(contaId);
      let estado = 'nao_configurada';
      if (configurada()) {
        estado = 'desconectada';
        if (instancias.length) {
          const estados = await Promise.all(instancias.map((i) => statusInstancia(i.nome_instancia)));
          if (estados.some((e) => e === 'conectada')) estado = 'conectada';
          else if (estados.some((e) => e === 'erro')) estado = 'erro';
        }
      }
      return json({ ok: true, configurada: configurada(), estado, conversas: t.conversas, disparos: t.disparos });
    }

    if (a === 'instancias_listar') {
      const instancias = await listarInstancias(contaId);
      if (configurada()) {
        await Promise.all(instancias.map(async (i) => {
          i.estado = await statusInstancia(i.nome_instancia);
          atualizarEstadoLocal(i.id, i.estado).catch(() => {});   // cache local, melhor-esforço
        }));
      }
      return json({ ok: true, instancias });
    }

    if (a === 'instancias_criar') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora conecta números novos.' });
      const rotulo = String(body.rotulo || '').trim().slice(0, 60);
      if (!rotulo) return json({ ok: false, error: 'Dê um nome pro número (ex: Vendas).' });
      const r = await criarInstancia(contaId, rotulo);
      return json(r);
    }

    if (a === 'instancias_qr') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora conecta o WhatsApp.' });
      const inst = (await listarInstancias(contaId)).find((i) => i.id === Number(body.id));
      if (!inst) return json({ ok: false, error: 'Instância não encontrada.' });
      const r = await qrInstancia(inst.nome_instancia);
      return json(r);
    }

    if (a === 'instancias_definir_padrao') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora altera isso.' });
      const r = await definirPadrao(contaId, body.id);
      return json(r);
    }

    if (a === 'instancias_remover') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora remove um número.' });
      const r = await removerInstancia(contaId, body.id);
      return json(r);
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
      const estadoIa = await lerEstadoConversa(contaId, tel).catch(() => ({ ia_pausada: false }));
      return json({ ok: true, mensagens, iaPausada: !!estadoIa.ia_pausada });
    }

    if (a === 'ia_estado') {
      const tel = normalizarTelefoneBR(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      const estadoIa = await lerEstadoConversa(contaId, tel);
      return json({ ok: true, iaPausada: !!estadoIa.ia_pausada });
    }

    if (a === 'ia_pausar') {
      const tel = normalizarTelefoneBR(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      await definirPausaConversa(contaId, tel, true, quem);
      return json({ ok: true });
    }

    if (a === 'ia_retomar') {
      const tel = normalizarTelefoneBR(body.telefone);
      if (!tel) return json({ ok: false, error: 'telefone obrigatório' });
      await definirPausaConversa(contaId, tel, false, quem);
      return json({ ok: true });
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
