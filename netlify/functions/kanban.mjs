/**
 * QUADROS KANBAN v3 — funil inteligente por atendente.
 *
 * Regras:
 *   - Todo quadro é vinculado a UM atendente (obrigatório). Admin vê todos;
 *     atendente vê só o seu (o filtro visual fica no painel; aqui garantimos
 *     as permissões de escrita).
 *   - Colunas OFICIAIS (tipo != ''): atribuido, conversa, followup, agendado,
 *     perdido, convertido. Não podem ser excluídas nem renomeadas; cor pode.
 *     'atribuido' é sempre a primeira. Colunas personalizadas (tipo '') são
 *     livres e NÃO mexem no status do lead.
 *   - Mover card para coluna oficial atualiza o Status (etapa/resultado) do
 *     lead. Follow-up e personalizadas são só organizacionais.
 *   - Adicionar um lead a um quadro = atribuí-lo ao atendente do quadro
 *     (cai na coluna Atribuído e sai dos outros quadros).
 *
 *   { token, action:'estado' }                                  → { ok, boards, cols, cards }
 *   { token, action:'board_criar',  nome, atendente, descricao? }
 *   { token, action:'board_editar', id, nome?, atendente?, descricao? }  (atendente: só admin)
 *   { token, action:'board_excluir', id }                       (só admin)
 *   { token, action:'col_criar',    board_id, nome }
 *   { token, action:'col_editar',   id, nome?, cor? }
 *   { token, action:'col_excluir',  id }
 *   { token, action:'card_criar',   board_id, col_id, lead_ref }
 *   { token, action:'card_mover',   id, col_id, motivo? }
 *   { token, action:'card_excluir', id }
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'As tabelas do Kanban ainda não existem. Rode o setup-crm.sql no Supabase (SQL Editor).';
const AVISO_SQL3 = 'Falta rodar o setup-kanban3.sql no Supabase (vínculo de quadros com atendentes e funil oficial).';
const LEADS = 'diag_instagram_leads';

/* colunas oficiais do funil — criadas em todo quadro, nesta ordem */
const FUNIL = [
  { tipo: 'atribuido', nome: 'Atribuído' },
  { tipo: 'conversa', nome: 'Em Conversa' },
  { tipo: 'followup', nome: 'Follow-up' },
  { tipo: 'agendado', nome: 'Agendado' },
  { tipo: 'perdido', nome: '✕ Perdido' },
  { tipo: 'convertido', nome: '✓ Convertido' },
];

const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const quem = String(auth.user.nome || '').trim() || 'Equipe';

  /* permissões: lead com atendente só é movimentado por ele (ou pela admin) */
  async function bloqueioLead(lead_ref) {
    if (auth.admin || !lead_ref) return null;
    const r = await sb(`${LEADS}?lead_ref=eq.${encodeURIComponent(lead_ref)}&select=atendente&limit=1`);
    if (!r.ok) return null;
    const resp = String(((await r.json())[0] || {}).atendente || '').trim();
    if (resp && resp !== quem) {
      return json({ ok: false, error: 'Este lead está vinculado ao atendente ' + resp + '. Somente o responsável ou a administradora podem movimentá-lo.' });
    }
    return null;
  }
  async function pegarCard(cardId) {
    const r = await sb(`kanban_cards?id=eq.${cardId}&select=id,board_id,col_id,lead_ref&limit=1`);
    return r.ok ? ((await r.json())[0] || null) : null;
  }
  async function pegarCol(colId) {
    let r = await sb(`kanban_cols?id=eq.${colId}&select=id,board_id,nome,tipo&limit=1`);
    if (!r.ok) r = await sb(`kanban_cols?id=eq.${colId}&select=id,board_id,nome&limit=1`);
    return r.ok ? ((await r.json())[0] || null) : null;
  }

  /* cria as colunas oficiais que faltarem num quadro; devolve mapa tipo→col */
  async function garantirFunil(board_id) {
    let r = await sb(`kanban_cols?board_id=eq.${board_id}&select=id,nome,tipo,ordem`);
    if (!r.ok) return null;   // sem coluna tipo ainda (setup-kanban3 não rodou)
    const atuais = await r.json();
    const porTipo = new Map(atuais.filter((c) => c.tipo).map((c) => [c.tipo, c]));
    const faltam = FUNIL.filter((f) => !porTipo.has(f.tipo));
    if (faltam.length) {
      const rc = await sb('kanban_cols', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(faltam.map((f) => ({ board_id, nome: f.nome, tipo: f.tipo, ordem: FUNIL.findIndex((x) => x.tipo === f.tipo) }))),
      });
      if (rc.ok) (await rc.json()).forEach((c) => porTipo.set(c.tipo, c));
    }
    return porTipo;
  }

  /* atualiza o Status do lead quando o card entra numa coluna OFICIAL */
  async function sincronizarLeadComColuna(lead_ref, tipo, motivo) {
    if (!tipo || tipo === 'followup') return { ok: true };   // organizacional: não mexe no status
    const refUrl = encodeURIComponent(lead_ref);
    let temResultado = true;
    let rl = await sb(`${LEADS}?lead_ref=eq.${refUrl}&select=resultado,equipe_json&limit=1`);
    if (!rl.ok) { temResultado = false; rl = await sb(`${LEADS}?lead_ref=eq.${refUrl}&select=equipe_json&limit=1`); }
    if (!rl.ok) return { ok: true };
    const lead = (await rl.json())[0] || {};

    let eq = { obs: '', campos: [], historico: [] };
    try { const p = JSON.parse(lead.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* vazio */ }

    const patch = { updated_at: new Date().toISOString() };
    const rotulos = { atribuido: 'Atribuído', conversa: 'Em Conversa', agendado: 'Agendado', perdido: 'PERDIDO ✕', convertido: 'CONVERTIDO ✓' };
    if (tipo === 'perdido' || tipo === 'convertido') {
      if (!temResultado) return { ok: false, error: 'Falta rodar o setup-resultado.sql no Supabase.' };
      if ((lead.resultado || '') !== tipo) {
        patch.resultado = tipo;
        patch.resultado_em = new Date().toISOString();
        patch.resultado_por = quem;
        patch.resultado_motivo = tipo === 'perdido' ? String(motivo || '').trim().slice(0, 300) : '';
        patch.etapa = '';
        eq.historico.unshift({ t: new Date().toISOString(), quem, txt: 'Status: ' + rotulos[tipo] + ' (movido no Kanban)' + (patch.resultado_motivo ? ' — motivo: ' + patch.resultado_motivo : '') });
      }
    } else {
      // sair de convertido/perdido de volta pro funil = reativação (só admin)
      if (temResultado && (lead.resultado || '')) {
        if (!auth.admin) return { ok: false, error: 'Somente a administradora pode reativar um lead convertido ou perdido (mova o card de volta com o acesso dela).' };
        patch.resultado = ''; patch.resultado_em = null; patch.resultado_por = ''; patch.resultado_motivo = '';
        eq.historico.unshift({ t: new Date().toISOString(), quem, txt: 'Lead reativado (movido no Kanban)' });
      }
      patch.etapa = tipo;
      eq.historico.unshift({ t: new Date().toISOString(), quem, txt: 'Status: ' + rotulos[tipo] + ' (movido no Kanban)' });
    }
    eq.historico = eq.historico.slice(0, 60);
    patch.equipe_json = JSON.stringify(eq);
    let rp = await sb(`${LEADS}?lead_ref=eq.${refUrl}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    if (!rp.ok) { delete patch.equipe_json; delete patch.etapa; rp = await sb(`${LEADS}?lead_ref=eq.${refUrl}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); }
    return { ok: true };
  }

  try {
    const a = body.action;
    const id = Number(body.id) || 0;

    if (a === 'estado') {
      let rb = await sb('kanban_boards?select=id,nome,atendente,descricao&order=criado_em.asc');
      let semVinculo = false;
      if (!rb.ok) { semVinculo = true; rb = await sb('kanban_boards?select=id,nome&order=criado_em.asc'); }
      if (!rb.ok) return json({ ok: false, error: AVISO_SQL });
      const boards = await rb.json();
      let cols = await sb('kanban_cols?select=id,board_id,nome,ordem,cor,tipo&order=ordem.asc,id.asc').then((r) => r.ok ? r.json() : null);
      if (!cols) cols = await sb('kanban_cols?select=id,board_id,nome,ordem,cor&order=ordem.asc,id.asc').then((r) => r.ok ? r.json() : null);
      if (!cols) cols = await sb('kanban_cols?select=id,board_id,nome,ordem&order=ordem.asc,id.asc').then((r) => r.ok ? r.json() : []);
      const cards = await sb('kanban_cards?select=id,board_id,col_id,lead_ref,ordem&order=ordem.asc,id.asc').then((r) => r.ok ? r.json() : []);
      return json({ ok: true, boards, cols, cards, semVinculo });
    }

    if (a === 'board_criar') {
      const nome = String(body.nome || '').trim().slice(0, 80);
      if (!nome) return json({ ok: false, error: 'Dê um nome ao quadro.' });
      // vínculo obrigatório: admin escolhe; atendente cria só pra si
      let atendente = String(body.atendente || '').trim().slice(0, 120);
      if (!auth.admin) atendente = quem;
      if (!atendente) return json({ ok: false, error: 'Todo quadro precisa de um atendente responsável.' });
      const descricao = String(body.descricao || '').trim().slice(0, 300);
      let r = await sb('kanban_boards', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ nome, atendente, descricao }) });
      if (!r.ok) {
        // sem as colunas novas ainda? cria simples e avisa
        r = await sb('kanban_boards', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ nome }) });
        if (!r.ok) return json({ ok: false, error: AVISO_SQL });
        const b0 = (await r.json())[0];
        return json({ ok: true, board_id: b0.id, aviso: AVISO_SQL3 });
      }
      const board = (await r.json())[0];
      await garantirFunil(board.id);
      return json({ ok: true, board_id: board.id });
    }

    if (a === 'board_editar') {
      const patch = {};
      if ('nome' in body) {
        const nome = String(body.nome || '').trim().slice(0, 80);
        if (!nome) return json({ ok: false, error: 'Dê um nome ao quadro.' });
        patch.nome = nome;
      }
      if ('atendente' in body) {
        if (!auth.admin) return json({ ok: false, error: 'Somente a administradora pode trocar o atendente responsável por um quadro.' });
        const at = String(body.atendente || '').trim().slice(0, 120);
        if (!at) return json({ ok: false, error: 'Todo quadro precisa de um atendente responsável.' });
        patch.atendente = at;
      }
      if ('descricao' in body) patch.descricao = String(body.descricao || '').trim().slice(0, 300);
      if (!Object.keys(patch).length) return json({ ok: false, error: 'nada para alterar' });
      const r = await sb(`kanban_boards?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (!r.ok && ('atendente' in patch || 'descricao' in patch)) return json({ ok: false, error: AVISO_SQL3 });
      return json({ ok: r.ok });
    }

    if (a === 'board_excluir') {
      if (!auth.admin) return json({ ok: false, error: 'Somente a administradora pode excluir um quadro.' });
      await sb(`kanban_cards?board_id=eq.${id}`, { method: 'DELETE' });
      await sb(`kanban_cols?board_id=eq.${id}`, { method: 'DELETE' });
      const r = await sb(`kanban_boards?id=eq.${id}`, { method: 'DELETE' });
      return json({ ok: r.ok });
    }

    if (a === 'col_criar') {
      const nome = String(body.nome || '').trim().slice(0, 60);
      const board_id = Number(body.board_id) || 0;
      if (!nome || !board_id) return json({ ok: false, error: 'Dê um nome à coluna.' });
      // personalizada: tipo vazio, entra depois das oficiais
      let r = await sb('kanban_cols', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ board_id, nome, tipo: '', ordem: 100 + (Date.now() % 100000) }) });
      if (!r.ok) r = await sb('kanban_cols', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ board_id, nome, ordem: 100 + (Date.now() % 100000) }) });
      return json({ ok: r.ok });
    }

    if (a === 'col_editar') {
      const col = await pegarCol(id);
      if (!col) return json({ ok: false, error: 'Coluna não encontrada.' });
      const patch = {};
      if ('nome' in body) {
        if (col.tipo) return json({ ok: false, error: 'As colunas oficiais do funil não podem ser renomeadas (só a cor pode mudar).' });
        const nome = String(body.nome || '').trim().slice(0, 60);
        if (!nome) return json({ ok: false, error: 'Dê um nome à coluna.' });
        patch.nome = nome;
      }
      if ('cor' in body) {
        const CORES = ['', 'verde', 'roxo', 'azul', 'vermelho', 'laranja', 'amarelo', 'rosa', 'turquesa', 'cinza', 'preto'];
        const cor = String(body.cor || '').trim();
        if (!CORES.includes(cor)) return json({ ok: false, error: 'cor inválida' });
        patch.cor = cor;
      }
      if (!Object.keys(patch).length) return json({ ok: false, error: 'nada para alterar' });
      const r = await sb(`kanban_cols?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (!r.ok && 'cor' in patch) return json({ ok: false, error: 'Falta rodar o setup-kanban2.sql no Supabase (cores das colunas).' });
      return json({ ok: r.ok });
    }

    if (a === 'col_excluir') {
      const col = await pegarCol(id);
      if (col && col.tipo) return json({ ok: false, error: 'As colunas oficiais do funil não podem ser excluídas.' });
      await sb(`kanban_cards?col_id=eq.${id}`, { method: 'DELETE' });
      const r = await sb(`kanban_cols?id=eq.${id}`, { method: 'DELETE' });
      return json({ ok: r.ok });
    }

    if (a === 'card_criar') {
      const board_id = Number(body.board_id) || 0;
      let col_id = Number(body.col_id) || 0;
      const lead_ref = String(body.lead_ref || '').trim();
      if (!board_id || !col_id || !lead_ref) return json({ ok: false, error: 'Dados incompletos.' });
      const dup = await sb(`kanban_cards?board_id=eq.${board_id}&lead_ref=eq.${encodeURIComponent(lead_ref)}&select=id&limit=1`);
      if (dup.ok && (await dup.json()).length) return json({ ok: false, error: 'Esse lead já está neste quadro.' });
      const bloq = await bloqueioLead(lead_ref); if (bloq) return bloq;

      // adicionar ao quadro = atribuir ao atendente do quadro (se ainda não for dele)
      const rb = await sb(`kanban_boards?id=eq.${board_id}&select=atendente&limit=1`);
      const donoQuadro = rb.ok ? String(((await rb.json())[0] || {}).atendente || '').trim() : '';
      if (donoQuadro) {
        const rl = await sb(`${LEADS}?lead_ref=eq.${encodeURIComponent(lead_ref)}&select=atendente,equipe_json&limit=1`);
        const lead = rl.ok ? ((await rl.json())[0] || {}) : {};
        if (String(lead.atendente || '').trim() !== donoQuadro) {
          let eq = { obs: '', campos: [], historico: [] };
          try { const p = JSON.parse(lead.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* vazio */ }
          eq.historico.unshift({ t: new Date().toISOString(), quem, txt: 'Atendente responsável: ' + donoQuadro + ' (adicionado ao quadro)' });
          eq.historico = eq.historico.slice(0, 60);
          let rp = await sb(`${LEADS}?lead_ref=eq.${encodeURIComponent(lead_ref)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: donoQuadro, etapa: 'atribuido', equipe_json: JSON.stringify(eq), updated_at: new Date().toISOString() }) });
          if (!rp.ok) await sb(`${LEADS}?lead_ref=eq.${encodeURIComponent(lead_ref)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: donoQuadro, updated_at: new Date().toISOString() }) });
          // sai dos quadros de outros atendentes e entra na coluna Atribuído deste
          await sb(`kanban_cards?lead_ref=eq.${encodeURIComponent(lead_ref)}&board_id=neq.${board_id}`, { method: 'DELETE' });
          const funil = await garantirFunil(board_id);
          if (funil && funil.get('atribuido')) col_id = funil.get('atribuido').id;
        }
      }
      const r = await sb('kanban_cards', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ board_id, col_id, lead_ref, ordem: Date.now() }) });
      return json({ ok: r.ok });
    }

    if (a === 'card_mover') {
      const col_id = Number(body.col_id) || 0;
      if (!id || !col_id) return json({ ok: false, error: 'Dados incompletos.' });
      const card = await pegarCard(id);
      if (!card) return json({ ok: false, error: 'Card não encontrado.' });
      const bloq = await bloqueioLead(card.lead_ref); if (bloq) return bloq;
      const col = await pegarCol(col_id);
      // coluna oficial → Status do lead acompanha (valida ANTES de mover)
      if (col && col.tipo) {
        const sync = await sincronizarLeadComColuna(card.lead_ref, col.tipo, body.motivo);
        if (!sync.ok) return json(sync);
      }
      const r = await sb(`kanban_cards?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ col_id, ordem: Date.now() }) });
      return json({ ok: r.ok });
    }

    if (a === 'card_excluir') {
      const card = await pegarCard(id);
      if (card) { const bloq = await bloqueioLead(card.lead_ref); if (bloq) return bloq; }
      const r = await sb(`kanban_cards?id=eq.${id}`, { method: 'DELETE' });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('kanban:', e?.message || e);
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

export const config = { path: '/api/kanban' };
