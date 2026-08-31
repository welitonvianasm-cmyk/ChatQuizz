/**
 * AGENTE IA — CRUD do painel de treinamento (config, conhecimento,
 * perguntas-e-respostas, arquivos). Fase 2: só dados — nenhuma chamada de
 * IA acontece aqui (isso é a Fase 3, em agente-processar-background.mjs).
 *
 *   { token, action:'agente_obter' }                → { ok, agente }
 *   { token, action:'agente_salvar', dados:{...} }   → { ok, agente }   (admin)
 *   { token, action:'qa_listar' }                    → { ok, itens }
 *   { token, action:'qa_criar', pergunta, resposta } → { ok, item }     (admin)
 *   { token, action:'qa_editar', id, ... }           → { ok }           (admin)
 *   { token, action:'qa_excluir', id }               → { ok }           (admin)
 *   { token, action:'arquivo_listar' }               → { ok, itens }
 *   { token, action:'arquivo_upload', nome, mimetype, base64, tipo_arquivo?, quando_enviar? } → { ok, item } (admin)
 *   { token, action:'arquivo_editar', id, ... }      → { ok }           (admin)
 *   { token, action:'arquivo_excluir', id }          → { ok }           (admin)
 *   { token, action:'arquivo_url', id }              → { ok, url }      (link assinado, 5min, pra pré-visualizar)
 *
 * Env: usa a mesma SUPABASE_DIAG_URL/SUPABASE_DIAG_SERVICE de sempre — o
 * bucket "agente-arquivos" (privado) precisa existir (setup-agente-ia.sql).
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { lerAgente, salvarAgente } from '../_agenteIa.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-agente-ia.sql no Supabase (módulo Agente IA).';
const BUCKET = 'agente-arquivos';
const MAX_BYTES = 4 * 1024 * 1024;   // 4MB cru — fica seguro abaixo do teto de payload das functions mesmo já inflado em base64
const MIME_PERMITIDOS = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

const AGENTE_PADRAO = { ativo: false, nome: 'Assistente', cargo: '', persona: '', conhecimento: '', instancia_id: null, estrategia_agenda: 'nenhuma', link_agendamento: '', duracao_reuniao_min: 30, mensagem_escalonamento: '' };

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

    if (a === 'agente_obter') {
      const agente = await lerAgente(contaId);
      return json({ ok: true, agente: agente || AGENTE_PADRAO });
    }

    if (a === 'agente_salvar') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora configura o Agente IA.' });
      const agente = await salvarAgente(contaId, body.dados || {});
      if (!agente) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, agente });
    }

    if (a === 'qa_listar') {
      const r = await fetch(`${SB_URL}/rest/v1/agente_qa?conta_id=eq.${contaId}&order=ordem.asc,id.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, itens: await r.json() });
    }

    if (a === 'qa_criar') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const pergunta = String(body.pergunta || '').trim();
      const resposta = String(body.resposta || '').trim();
      if (!pergunta || !resposta) return json({ ok: false, error: 'Preencha pergunta e resposta.' });
      const r = await fetch(`${SB_URL}/rest/v1/agente_qa`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ conta_id: contaId, pergunta: pergunta.slice(0, 500), resposta: resposta.slice(0, 4000) }),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, item: (await r.json())[0] });
    }

    if (a === 'qa_editar') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const patch = {};
      if ('pergunta' in body) patch.pergunta = String(body.pergunta || '').trim().slice(0, 500);
      if ('resposta' in body) patch.resposta = String(body.resposta || '').trim().slice(0, 4000);
      if ('ativo' in body) patch.ativo = !!body.ativo;
      if ('ordem' in body) patch.ordem = Number(body.ordem) || 0;
      const r = await fetch(`${SB_URL}/rest/v1/agente_qa?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: r.ok });
    }

    if (a === 'qa_excluir') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const r = await fetch(`${SB_URL}/rest/v1/agente_qa?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    if (a === 'arquivo_listar') {
      const r = await fetch(`${SB_URL}/rest/v1/agente_arquivos?conta_id=eq.${contaId}&order=criado_em.desc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, itens: await r.json() });
    }

    if (a === 'arquivo_upload') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const nome = String(body.nome || '').trim().slice(0, 160);
      const mimetype = String(body.mimetype || '').trim().toLowerCase();
      const base64 = String(body.base64 || '');
      const tipoArquivo = String(body.tipo_arquivo || (mimetype.startsWith('image/') ? 'imagem' : 'documento'));
      const quandoEnviar = String(body.quando_enviar || '').trim().slice(0, 500);
      if (!nome || !base64) return json({ ok: false, error: 'Nome e arquivo são obrigatórios.' });
      if (!MIME_PERMITIDOS.includes(mimetype)) return json({ ok: false, error: 'Formato não permitido — use PNG, JPEG, WEBP ou PDF.' });
      let bytes;
      try { bytes = Buffer.from(base64, 'base64'); } catch { return json({ ok: false, error: 'Arquivo inválido.' }); }
      if (!bytes.length) return json({ ok: false, error: 'Arquivo inválido.' });
      if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'Arquivo muito grande (máximo 4MB).' });

      const path = `${contaId}/${Date.now()}-${nome.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const rUp = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': mimetype },
        body: bytes,
      });
      if (!rUp.ok) {
        const errText = await rUp.text().catch(() => '');
        console.error('agente-config upload error:', rUp.status, errText.slice(0, 300));
        return json({ ok: false, error: 'Erro ao subir o arquivo pro Storage (confira se o bucket "agente-arquivos" existe — rode o setup-agente-ia.sql).' });
      }
      const r = await fetch(`${SB_URL}/rest/v1/agente_arquivos`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ conta_id: contaId, nome, tipo_arquivo: tipoArquivo, mimetype, storage_path: path, tamanho_bytes: bytes.length, quando_enviar: quandoEnviar }),
      });
      if (!r.ok) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: true, item: (await r.json())[0] });
    }

    if (a === 'arquivo_editar') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const patch = {};
      if ('nome' in body) patch.nome = String(body.nome || '').trim().slice(0, 160);
      if ('quando_enviar' in body) patch.quando_enviar = String(body.quando_enviar || '').trim().slice(0, 500);
      if ('ativo' in body) patch.ativo = !!body.ativo;
      const r = await fetch(`${SB_URL}/rest/v1/agente_arquivos?id=eq.${id}&conta_id=eq.${contaId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return json({ ok: r.ok });
    }

    if (a === 'arquivo_excluir') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora edita o treinamento.' });
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const rSel = await fetch(`${SB_URL}/rest/v1/agente_arquivos?id=eq.${id}&conta_id=eq.${contaId}&select=storage_path&limit=1`, { headers: H });
      const row = rSel.ok ? (await rSel.json())[0] : null;
      if (row && row.storage_path) {
        try {
          await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${row.storage_path}`, { method: 'DELETE', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
        } catch { /* melhor-esforço — remove a linha mesmo se o arquivo não sumir do Storage */ }
      }
      const r = await fetch(`${SB_URL}/rest/v1/agente_arquivos?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    if (a === 'arquivo_url') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'id obrigatório' });
      const rSel = await fetch(`${SB_URL}/rest/v1/agente_arquivos?id=eq.${id}&conta_id=eq.${contaId}&select=storage_path&limit=1`, { headers: H });
      const row = rSel.ok ? (await rSel.json())[0] : null;
      if (!row) return json({ ok: false, error: 'Arquivo não encontrado.' });
      const rSign = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${row.storage_path}`, {
        method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      if (!rSign.ok) return json({ ok: false, error: 'Erro ao gerar link de visualização.' });
      const d = await rSign.json().catch(() => ({}));
      const caminho = d.signedURL || d.signedUrl || '';
      if (!caminho) return json({ ok: false, error: 'Erro ao gerar link de visualização.' });
      return json({ ok: true, url: `${SB_URL}/storage/v1${caminho}` });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('agente-config:', e?.message || e);
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

export const config = { path: '/api/agente-config' };
