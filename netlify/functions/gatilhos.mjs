/**
 * GATILHOS — condições reusáveis que disparam Automações, criadas pelo
 * usuário no painel (Gestão > Gatilhos), sem precisar de código novo.
 * Cada gatilho tem um `tipo` (com validação própria de `config`):
 *
 *   'agendado'     → config: { modo:'unica', data_hora } ou
 *                    { modo:'recorrente', hora:'HH:MM', frequencia:'diaria'|'semanal', dias_semana?:[0..6] }
 *                    Não tem lead associado — quem recebe é escolhido na
 *                    Automação (campo `publico`, ver automacoes.mjs — agora
 *                    também aceita 'atendente' e 'pergunta' além de
 *                    'qualificador'/'etiqueta').
 *   'tag'          → config: { etiqueta_id, atraso? } — dispara quando um lead
 *                    RECEBE essa etiqueta (ver netlify/functions/etiquetas.mjs, lead_definir)
 *   'qualificador' → config: { qualificador_chave, atraso? } — dispara quando um
 *                    lead é salvo com esse qualificador (ver save-lead.mjs)
 *   'agendamento'  → config: { quando:'antes'|'depois', valor, unidade:'horas'|'dias' }
 *                    — dispara X horas/dias antes (lembrete) ou depois
 *                    (follow-up) da reunião marcada do lead (generaliza o
 *                    gatilho legado 'reuniao_1h', que continua existindo
 *                    intocado — ver netlify/functions/wa-cron.mjs)
 *
 *   `atraso` (opcional, só em 'tag'/'qualificador'): { modo:'imediato' } —
 *   padrão, manda na hora — ou { modo:'apos', valor, unidade:'minutos'|'horas'|'dias' }
 *   pra mandar um tempo depois do evento (entra na fila de disparos em vez
 *   de mandar direto).
 *
 *   POST /api/gatilhos { token, action:'listar' }                         → { ok, gatilhos }
 *   POST /api/gatilhos { token, action:'criar', nome, tipo, config }      → { ok, gatilho }   [admin]
 *   POST /api/gatilhos { token, action:'editar', id, nome?, config?, ativo? } → { ok }         [admin]
 *   POST /api/gatilhos { token, action:'excluir', id }                    → { ok }            [admin]
 *       (excluir não apaga Automações que usam esse gatilho — elas ficam
 *       sem gatilho, `automacoes.gatilho_id` vira null, e a automação some
 *       da lista de "ativas de verdade" até apontar pra outro gatilho)
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { carregarConfigPublicada } from '../_quiz.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-gatilhos.sql no Supabase (módulo Gatilhos).';
const TIPOS = ['agendado', 'tag', 'qualificador', 'agendamento'];
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UNIDADES_ATRASO = ['minutos', 'horas', 'dias'];

// { modo:'imediato' } ou { modo:'apos', valor, unidade } — usado em
// 'tag'/'qualificador' pra atrasar o envio em vez de mandar na hora
function validarAtraso(c) {
  const a = (c && typeof c === 'object') ? c : {};
  if (a.modo !== 'apos') return { limpo: { modo: 'imediato' } };
  const valor = Number(a.valor) || 0;
  if (valor <= 0) return { erro: 'Informe quanto tempo depois do evento a mensagem deve ir.' };
  const unidade = UNIDADES_ATRASO.includes(a.unidade) ? a.unidade : 'horas';
  return { limpo: { modo: 'apos', valor, unidade } };
}

async function validarConfig(contaId, tipo, config) {
  const c = (config && typeof config === 'object') ? config : {};
  if (tipo === 'agendamento') {
    const quando = c.quando === 'depois' ? 'depois' : 'antes';
    const valor = Number(c.valor) || 0;
    if (valor <= 0) return { erro: 'Informe quanto tempo antes/depois da reunião.' };
    const unidade = c.unidade === 'dias' ? 'dias' : 'horas';
    return { limpo: { quando, valor, unidade } };
  }
  if (tipo === 'agendado') {
    const modo = c.modo === 'recorrente' ? 'recorrente' : 'unica';
    if (modo === 'unica') {
      const d = new Date(c.data_hora);
      if (!c.data_hora || isNaN(d)) return { erro: 'Informe a data e o horário.' };
      return { limpo: { modo, data_hora: d.toISOString() } };
    }
    if (!HORA_RE.test(String(c.hora || ''))) return { erro: 'Informe um horário válido (HH:MM).' };
    const frequencia = c.frequencia === 'semanal' ? 'semanal' : 'diaria';
    const limpo = { modo, hora: c.hora, frequencia };
    if (frequencia === 'semanal') {
      const dias = Array.isArray(c.dias_semana) ? c.dias_semana.map(Number).filter((n) => n >= 0 && n <= 6) : [];
      if (!dias.length) return { erro: 'Escolha pelo menos 1 dia da semana.' };
      limpo.dias_semana = [...new Set(dias)];
    }
    return { limpo };
  }
  if (tipo === 'tag') {
    const etiquetaId = Number(c.etiqueta_id) || 0;
    if (!etiquetaId) return { erro: 'Escolha uma etiqueta.' };
    const r = await fetch(`${SB_URL}/rest/v1/etiquetas?id=eq.${etiquetaId}&conta_id=eq.${contaId}&select=id&limit=1`, { headers: H });
    if (!r.ok || !(await r.json())[0]) return { erro: 'Etiqueta não encontrada.' };
    const va = validarAtraso(c.atraso);
    if (va.erro) return va;
    return { limpo: { etiqueta_id: etiquetaId, atraso: va.limpo } };
  }
  if (tipo === 'qualificador') {
    const chave = String(c.qualificador_chave || '').trim().slice(0, 40);
    if (!chave) return { erro: 'Escolha um qualificador.' };
    const { doc } = await carregarConfigPublicada(SB_URL, H, contaId);
    if (!(doc.qualificadores || []).some((q) => q.chave === chave)) return { erro: 'Qualificador não encontrado.' };
    const va = validarAtraso(c.atraso);
    if (va.erro) return va;
    return { limpo: { qualificador_chave: chave, atraso: va.limpo } };
  }
  return { erro: 'Tipo de gatilho inválido.' };
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
      const r = await fetch(`${SB_URL}/rest/v1/gatilhos?conta_id=eq.${contaId}&select=id,nome,tipo,config,ativo,criado_em&order=criado_em.desc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const rows = await r.json();
      rows.forEach((g) => { try { g.config = JSON.parse(g.config || '{}'); } catch { g.config = {}; } });
      return json({ ok: true, gatilhos: rows });
    }

    if (body.action === 'criar') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const nome = String(body.nome || '').trim().slice(0, 80);
      const tipo = String(body.tipo || '').trim();
      if (!nome) return json({ ok: false, error: 'Dê um nome ao gatilho.' });
      if (!TIPOS.includes(tipo)) return json({ ok: false, error: 'Tipo de gatilho inválido.' });
      const v = await validarConfig(contaId, tipo, body.config);
      if (v.erro) return json({ ok: false, error: v.erro });
      const r = await fetch(`${SB_URL}/rest/v1/gatilhos`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ conta_id: contaId, nome, tipo, config: JSON.stringify(v.limpo) }),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const linha = (await r.json())[0];
      linha.config = v.limpo;
      return json({ ok: true, gatilho: linha });
    }

    if (body.action === 'editar') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const patch = {};
      if (body.nome !== undefined) patch.nome = String(body.nome).trim().slice(0, 80);
      if (body.ativo !== undefined) patch.ativo = !!body.ativo;
      if (body.config !== undefined) {
        const rTipo = await fetch(`${SB_URL}/rest/v1/gatilhos?id=eq.${id}&conta_id=eq.${contaId}&select=tipo&limit=1`, { headers: H });
        const atual = rTipo.ok ? (await rTipo.json())[0] : null;
        if (!atual) return json({ ok: false, error: 'Gatilho não encontrado.' });
        const v = await validarConfig(contaId, atual.tipo, body.config);
        if (v.erro) return json({ ok: false, error: v.erro });
        patch.config = JSON.stringify(v.limpo);
      }
      if (!Object.keys(patch).length) return json({ ok: false, error: 'nada para alterar' });
      const r = await fetch(`${SB_URL}/rest/v1/gatilhos?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: r.ok });
    }

    if (body.action === 'excluir') {
      if (!auth.admin) return json({ error: 'apenas administradores' }, 403);
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/gatilhos?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('gatilhos:', e?.message || e);
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

export const config = { path: '/api/gatilhos' };
