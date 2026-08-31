/**
 * PRODUTOS — catálogo usado na conversão (Pós-Venda).
 *
 *   POST /api/produtos { token, action:'listar' }
 *     → { ok, produtos: [{id,nome,valor,aliases:[nomeExterno,...]}] }
 *   POST /api/produtos { token, action:'criar', nome, valor }        → { ok, produto }
 *   POST /api/produtos { token, action:'editar', id, nome, valor }   → { ok, produto }
 *   POST /api/produtos { token, action:'excluir', id }               → { ok }
 *   POST /api/produtos { token, action:'vincular_alias', nome_externo, produto_id } → { ok }
 *     (associa o nome que vem do webhook de pagamento a um produto do catálogo —
 *      da próxima vez que esse nome externo chegar, já resolve sozinho)
 *
 * Qualquer usuário autenticado lista; criação/edição/vínculo também são
 * liberados pra equipe (o atendente cadastra o produto na hora de fechar a venda).
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-posvenda.sql no Supabase (tabela de produtos).';

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
      // embed dos aliases (produto_aliases → produtos via FK) — se a tabela
      // ainda não existir (setup-pagamento-webhook.sql não rodou), cai pro
      // select simples: a tela de Produtos continua funcionando, só sem aliases.
      // Campos do Agente IA (descricao/link_destino/instrucoes_agente) também
      // podem não existir ainda (setup-agente-ia.sql) — mesmo fallback.
      let r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&select=id,nome,valor,descricao,link_destino,instrucoes_agente,produto_aliases(nome_externo)&order=nome.asc`, { headers: H });
      let comAgenteIa = r.ok;
      let comAliases = r.ok;
      if (!r.ok) r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&select=id,nome,valor,produto_aliases(nome_externo)&order=nome.asc`, { headers: H });
      if (!r.ok) { comAliases = false; r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&select=id,nome,valor&order=nome.asc`, { headers: H }); }
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const linhas = await r.json();
      const produtos = linhas.map((p) => ({
        id: p.id, nome: p.nome, valor: p.valor,
        descricao: comAgenteIa ? (p.descricao || '') : '',
        link_destino: comAgenteIa ? (p.link_destino || '') : '',
        instrucoes_agente: comAgenteIa ? (p.instrucoes_agente || '') : '',
        aliases: comAliases ? (p.produto_aliases || []).map((a) => a.nome_externo) : [],
      }));
      return json({ ok: true, produtos });
    }

    if (body.action === 'criar') {
      const nome = String(body.nome || '').trim().slice(0, 120);
      const valor = Math.max(0, Number(body.valor) || 0);
      if (!nome) return json({ ok: false, error: 'Dê um nome ao produto.' });
      // evita duplicar pelo nome (ignorando maiúsculas)
      const dup = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&nome=ilike.${encodeURIComponent(nome)}&select=id,nome,valor&limit=1`, { headers: H });
      if (dup.ok) { const d = await dup.json(); if (d.length) return json({ ok: true, produto: d[0], jaExistia: true }); }
      const novo = { conta_id: contaId, nome, valor };
      if ('descricao' in body) novo.descricao = String(body.descricao || '').trim().slice(0, 1000);
      if ('link_destino' in body) novo.link_destino = String(body.link_destino || '').trim().slice(0, 500);
      if ('instrucoes_agente' in body) novo.instrucoes_agente = String(body.instrucoes_agente || '').trim().slice(0, 1000);
      let r = await fetch(`${SB_URL}/rest/v1/produtos`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify(novo),
      });
      if (!r.ok) {
        // colunas do Agente IA podem não existir ainda — tenta sem elas
        delete novo.descricao; delete novo.link_destino; delete novo.instrucoes_agente;
        r = await fetch(`${SB_URL}/rest/v1/produtos`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify(novo),
        });
      }
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, produto: (await r.json())[0] });
    }

    if (body.action === 'editar') {
      const id = Number(body.id);
      const nome = String(body.nome || '').trim().slice(0, 120);
      const valor = Math.max(0, Number(body.valor) || 0);
      if (!id) return json({ ok: false, error: 'Produto inválido.' });
      if (!nome) return json({ ok: false, error: 'Dê um nome ao produto.' });
      const patch = { nome, valor };
      if ('descricao' in body) patch.descricao = String(body.descricao || '').trim().slice(0, 1000);
      if ('link_destino' in body) patch.link_destino = String(body.link_destino || '').trim().slice(0, 500);
      if ('instrucoes_agente' in body) patch.instrucoes_agente = String(body.instrucoes_agente || '').trim().slice(0, 1000);
      let r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&id=eq.${id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        delete patch.descricao; delete patch.link_destino; delete patch.instrucoes_agente;
        r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&id=eq.${id}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        });
      }
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      const linha = (await r.json())[0];
      if (!linha) return json({ ok: false, error: 'Produto não encontrado.' });
      return json({ ok: true, produto: linha });
    }

    if (body.action === 'excluir') {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: 'Produto inválido.' });
      const r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&id=eq.${id}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    if (body.action === 'vincular_alias') {
      const nome_externo = String(body.nome_externo || '').trim().slice(0, 120);
      const produto_id = Number(body.produto_id);
      if (!nome_externo || !produto_id) return json({ ok: false, error: 'Informe o nome recebido e o produto de destino.' });
      const r = await fetch(`${SB_URL}/rest/v1/produto_aliases?on_conflict=conta_id,nome_externo`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ conta_id: contaId, nome_externo, produto_id }),
      });
      if (!r.ok) return json({ ok: false, error: 'Falta rodar o setup-pagamento-webhook.sql no Supabase (vínculo de produtos).' });
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('produtos:', e?.message || e);
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

export const config = { path: '/api/produtos' };
