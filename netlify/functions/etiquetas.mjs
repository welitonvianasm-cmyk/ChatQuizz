/**
 * ETIQUETAS — tags livres pra marcar leads. Catálogo por conta (Gestão >
 * Etiquetas, admin-only) + vínculo N:N com o lead (qualquer atendente pode
 * marcar/desmarcar). Usadas no Cartão do Lead (chips) e na busca por coluna
 * do Kanban (nome da etiqueta).
 *
 *   POST /api/etiquetas { token, action:'listar' }                    → { ok, etiquetas }
 *   POST /api/etiquetas { token, action:'criar', nome, cor }          → { ok, etiqueta }      [admin]
 *   POST /api/etiquetas { token, action:'editar', id, nome, cor, ativo, ordem } → { ok }       [admin]
 *   POST /api/etiquetas { token, action:'excluir', id }               → { ok }                [admin]
 *   POST /api/etiquetas { token, action:'lead_listar', lead_ref }     → { ok, etiqueta_ids }
 *   POST /api/etiquetas { token, action:'lead_definir', lead_ref, etiqueta_ids }  → { ok }
 *   POST /api/etiquetas { token, action:'todas_por_lead' }            → { ok, mapa: { lead_ref: [id,...] } }
 *
 * 'lead_definir' também RECONCILIA a fila de disparos pendentes desse lead
 * (netlify/_publico.mjs, reconciliarDisparosPendentes): se uma etiqueta que
 * disparou um gatilho tipo 'tag' atrasado (ou que era o filtro `publico`
 * de outra automação) for removida antes do envio, o disparo pendente é
 * cancelado — não manda uma mensagem que já não faz sentido.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { enviarWhats } from './whatsapp.mjs';
import { leadCombinaPublico, reconciliarDisparosPendentes } from '../_publico.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-etiquetas.sql no Supabase (módulo Etiquetas).';

// { modo:'imediato' } → undefined (manda na hora); { modo:'apos', valor, unidade } → ms de atraso
function atrasoMs(atraso) {
  if (!atraso || atraso.modo !== 'apos') return 0;
  const unidadeMs = atraso.unidade === 'dias' ? 86400000 : atraso.unidade === 'minutos' ? 60000 : 3600000;
  return (Number(atraso.valor) || 0) * unidadeMs;
}

/* dispara as Automações com gatilho tipo 'tag' quando o lead RECEBE uma
   etiqueta nova (não redispara se a etiqueta já estava lá — só quando
   entra no conjunto pela primeira vez). Melhor-esforço: nunca derruba o
   salvar da etiqueta em si. Sem `destino` configurado na automação, manda
   pro próprio lead; com `destino`, manda pra esse número (aviso interno).
   `publico` da automação (se houver) é um filtro EXTRA sobre esse mesmo
   lead (ex.: só dispara se o atendente dele for X). `atraso` do gatilho
   (imediato ou X tempo depois) decide se manda na hora ou entra na fila
   de disparos (netlify/functions/disparos.mjs, processada pelo cron). */
async function dispararGatilhosTag(contaId, leadRef, etiquetaIdsNovas) {
  if (!etiquetaIdsNovas.length) return;
  try {
    const rg = await fetch(`${SB_URL}/rest/v1/gatilhos?conta_id=eq.${contaId}&tipo=eq.tag&ativo=eq.true&select=id,config`, { headers: H });
    if (!rg.ok) return;
    const gatilhos = (await rg.json()).filter((g) => {
      let cfg = {}; try { cfg = JSON.parse(g.config || '{}'); } catch { /* vazio */ }
      return etiquetaIdsNovas.includes(Number(cfg.etiqueta_id));
    });
    if (!gatilhos.length) return;

    const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=nome,whatsapp,atendente,call_track,respostas_json&limit=1`, { headers: H });
    const lead = rl.ok ? (await rl.json())[0] : null;
    if (!lead) return;
    const nome = String(lead.nome || '').trim().split(/\s+/)[0] || 'tudo bem';

    const rEt = await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=etiqueta_id`, { headers: H });
    const leadComEtiquetas = { ...lead, etiqueta_ids: rEt.ok ? (await rEt.json()).map((x) => x.etiqueta_id) : [] };

    for (const g of gatilhos) {
      let cfg = {}; try { cfg = JSON.parse(g.config || '{}'); } catch { /* vazio */ }
      const ra = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&gatilho_id=eq.${g.id}&ativa=eq.true&select=id,mensagem,destino,publico`, { headers: H });
      const automs = ra.ok ? await ra.json() : [];
      for (const am of automs) {
        const alvo = am.destino || lead.whatsapp;
        if (!alvo || !am.mensagem) continue;
        let publico = {}; try { publico = JSON.parse(am.publico || '{}'); } catch { /* sem filtro extra */ }
        if (!leadCombinaPublico(leadComEtiquetas, publico)) continue;
        const texto = String(am.mensagem).replaceAll('{{nome}}', nome);
        const atraso = atrasoMs(cfg.atraso);
        if (atraso > 0) {
          await fetch(`${SB_URL}/rest/v1/disparos`, {
            method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({
              conta_id: contaId, telefone: alvo.replace(/\D/g, ''), lead_ref: leadRef, nome: lead.nome || '',
              mensagem: texto, enviar_em: new Date(Date.now() + atraso).toISOString(),
              status: 'pendente', origem: 'automacao:' + am.id,
            }),
          }).catch(() => {});
        } else {
          await enviarWhats(contaId, alvo, texto, 'Automação', leadRef).catch(() => {});
        }
      }
    }
  } catch { /* automação de tag é melhor-esforço */ }
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
      const r = await fetch(`${SB_URL}/rest/v1/etiquetas?conta_id=eq.${contaId}&select=id,nome,cor,ordem,ativo&order=ordem.asc,nome.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, etiquetas: await r.json() });
    }

    if (body.action === 'criar') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const nome = String(body.nome || '').trim().slice(0, 60);
      if (!nome) return json({ ok: false, error: 'Informe um nome.' });
      const cor = /^#[0-9a-fA-F]{6}$/.test(body.cor || '') ? body.cor : '#22A55E';
      const r = await fetch(`${SB_URL}/rest/v1/etiquetas`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ conta_id: contaId, nome, cor }),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, etiqueta: (await r.json())[0] });
    }

    if (body.action === 'editar') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const patch = {};
      if (body.nome !== undefined) patch.nome = String(body.nome).trim().slice(0, 60);
      if (body.cor !== undefined && /^#[0-9a-fA-F]{6}$/.test(body.cor)) patch.cor = body.cor;
      if (body.ativo !== undefined) patch.ativo = !!body.ativo;
      if (body.ordem !== undefined) patch.ordem = Number(body.ordem) || 0;
      const r = await fetch(`${SB_URL}/rest/v1/etiquetas?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: r.ok });
    }

    if (body.action === 'excluir') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/etiquetas?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    if (body.action === 'lead_listar') {
      const leadRef = String(body.lead_ref || '').trim();
      if (!leadRef) return json({ ok: false, error: 'lead_ref obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=etiqueta_id`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, etiqueta_ids: (await r.json()).map((x) => x.etiqueta_id) });
    }

    if (body.action === 'lead_definir') {
      const leadRef = String(body.lead_ref || '').trim();
      if (!leadRef) return json({ ok: false, error: 'lead_ref obrigatório' });
      const ids = Array.isArray(body.etiqueta_ids) ? [...new Set(body.etiqueta_ids.map((x) => Number(x)).filter(Boolean))] : [];

      const rAntes = await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=etiqueta_id`, { headers: H });
      const antesIds = rAntes.ok ? (await rAntes.json()).map((x) => x.etiqueta_id) : [];
      const novas = ids.filter((id) => !antesIds.includes(id));   // só as que entraram AGORA disparam gatilho
      const removidas = antesIds.filter((id) => !ids.includes(id));

      await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}`, { method: 'DELETE', headers: H });
      if (ids.length) {
        await fetch(`${SB_URL}/rest/v1/lead_etiquetas`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify(ids.map((etiqueta_id) => ({ conta_id: contaId, lead_ref: leadRef, etiqueta_id }))),
        });
      }
      // await de propósito (não fire-and-forget): numa function serverless,
      // devolver a resposta ANTES pode matar o processo no meio do envio
      if (novas.length) await dispararGatilhosTag(contaId, leadRef, novas);
      // etiqueta REMOVIDA pode invalidar um disparo ainda pendente de um
      // gatilho 'tag' atrasado (ou um filtro publico='etiqueta' de outra
      // automação) — cancela o que não faz mais sentido mandar
      if (novas.length || removidas.length) await reconciliarDisparosPendentes(SB_URL, H, contaId, leadRef);
      return json({ ok: true });
    }

    if (body.action === 'todas_por_lead') {
      const r = await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&select=lead_ref,etiqueta_id&limit=20000`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const linhas = await r.json();
      const mapa = {};
      linhas.forEach((x) => { (mapa[x.lead_ref] = mapa[x.lead_ref] || []).push(x.etiqueta_id); });
      return json({ ok: true, mapa });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('etiquetas:', e?.message || e);
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

export const config = { path: '/api/etiquetas' };
