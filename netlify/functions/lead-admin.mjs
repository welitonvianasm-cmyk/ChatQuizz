/**
 * Ações da equipe sobre leads (qualquer usuário autenticado do painel):
 *
 *   POST /api/lead-admin { token, lead_ref, campos: { atendente?, agendamento_status?, obs?, campos_extras? } }
 *     → { ok, equipe_json }   (equipe_json = anotações/campos/histórico atualizados)
 *   POST /api/lead-admin { token, action:'excluir', lead_ref }
 *     → { ok }   (remove o lead da base e dos quadros Kanban)
 *
 * equipe_json (coluna no lead) = { obs, campos:[{k,v}], historico:[{t,quem,txt}] }
 * O histórico é preenchido AUTOMATICAMENTE a cada mudança, com o nome de quem fez.
 *
 * PREPARADO PARA O FUTURO: integração real com o cal.com usa o booking_uid já salvo.
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const STATUS_VALIDOS = ['', 'concluido', 'reagendado', 'cancelado', 'compareceu', 'nao_compareceu'];
const ETAPAS_VALIDAS = ['', 'novo', 'atribuido', 'conversa', 'agendado'];   // perdido/convertido vivem no `resultado`
const AVISO_SQL = 'Falta rodar o setup-card.sql no Supabase (coluna de anotações da equipe).';

/* colunas oficiais do funil (espelho do kanban.mjs) */
const FUNIL = [
  { tipo: 'atribuido', nome: 'Atribuído' },
  { tipo: 'conversa', nome: 'Em Conversa' },
  { tipo: 'followup', nome: 'Follow-up' },
  { tipo: 'agendado', nome: 'Agendado' },
  { tipo: 'perdido', nome: '✕ Perdido' },
  { tipo: 'convertido', nome: '✓ Convertido' },
];

/* Posiciona o lead no quadro Kanban do atendente dele, na coluna oficial
   `tipoCol` — criando o card (e as colunas do funil) se precisar, e tirando
   o lead dos quadros de outros atendentes. Melhor-esforço: falha em silêncio. */
async function moverNoKanban(lead_ref, atendente, tipoCol) {
  try {
    const refUrl = encodeURIComponent(lead_ref);
    const resp = String(atendente || '').trim();
    if (!resp) {   // sem responsável: o lead sai dos quadros por atendente
      await fetch(`${SB_URL}/rest/v1/kanban_cards?lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H });
      return;
    }
    const rb = await fetch(`${SB_URL}/rest/v1/kanban_boards?atendente=eq.${encodeURIComponent(resp)}&select=id&limit=1`, { headers: H });
    if (!rb.ok) return;   // coluna atendente ainda não existe (setup-kanban3)
    const board = (await rb.json())[0];
    if (!board) return;   // atendente sem quadro: nada a fazer
    const rc = await fetch(`${SB_URL}/rest/v1/kanban_cols?board_id=eq.${board.id}&select=id,tipo`, { headers: H });
    if (!rc.ok) return;
    const cols = await rc.json();
    let alvo = cols.find((c) => c.tipo === tipoCol);
    if (!alvo) {
      const faltam = FUNIL.filter((f) => !cols.some((c) => c.tipo === f.tipo));
      if (faltam.length) {
        const rn = await fetch(`${SB_URL}/rest/v1/kanban_cols`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify(faltam.map((f) => ({ board_id: board.id, nome: f.nome, tipo: f.tipo, ordem: FUNIL.findIndex((x) => x.tipo === f.tipo) }))),
        });
        if (rn.ok) alvo = (await rn.json()).find((c) => c.tipo === tipoCol);
      }
    }
    if (!alvo) return;
    // sai dos quadros de outros atendentes
    await fetch(`${SB_URL}/rest/v1/kanban_cards?lead_ref=eq.${refUrl}&board_id=neq.${board.id}`, { method: 'DELETE', headers: H });
    // move (ou cria) o card no quadro do responsável
    const rcard = await fetch(`${SB_URL}/rest/v1/kanban_cards?lead_ref=eq.${refUrl}&board_id=eq.${board.id}&select=id&limit=1`, { headers: H });
    const card = rcard.ok ? (await rcard.json())[0] : null;
    if (card) await fetch(`${SB_URL}/rest/v1/kanban_cards?id=eq.${card.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ col_id: alvo.id, ordem: Date.now() }) });
    else await fetch(`${SB_URL}/rest/v1/kanban_cards`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ board_id: board.id, col_id: alvo.id, lead_ref, ordem: Date.now() }) });
  } catch { /* kanban é acompanhamento; o dado principal já foi salvo */ }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  const ref = String(body.lead_ref || '').trim();
  if (!ref) return json({ ok: false, error: 'lead_ref obrigatório' });
  const refUrl = encodeURIComponent(ref);

  /* controle de permissões: lead com atendente é exclusivo dele (e da admin) */
  const semPermissao = (atendenteAtual) => {
    const resp = String(atendenteAtual || '').trim();
    return !!resp && !auth.admin && resp !== String(auth.user.nome || '').trim();
  };
  const erroBloqueio = (resp) => json({
    ok: false,
    error: 'Este lead está vinculado ao atendente ' + String(resp || '').trim()
      + '. Somente o responsável ou a administradora podem acessá-lo e alterá-lo.',
  });

  try {
    /* ---------- EXCLUIR lead (com confirmação já feita no painel) ---------- */
    if (body.action === 'excluir') {
      const rp = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=atendente&limit=1`, { headers: H });
      if (rp.ok) {
        const row = (await rp.json())[0] || {};
        if (semPermissao(row.atendente)) return erroBloqueio(row.atendente);
      }
      try { await fetch(`${SB_URL}/rest/v1/kanban_cards?lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H }); } catch { /* melhor-esforço */ }
      try { await fetch(`${SB_URL}/rest/v1/alertas?lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H }); } catch { /* melhor-esforço */ }
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    /* ---------- AGENDAR pelo painel (Cal.com embutido no CRM) ----------
       O horário já foi reservado no Cal pelo embed; aqui só espelhamos no
       lead: data, código de confirmação, trilha e linha no histórico. */
    if (body.action === 'agendar') {
      const quem2 = auth.user.nome || 'Equipe';
      const em = body.agendamento_em ? new Date(body.agendamento_em) : null;
      const emISO = em && !isNaN(em) ? em.toISOString() : null;
      const uid = String(body.booking_uid || '').trim().slice(0, 120);
      // agenda ÚNICA (Imersão unificada na Comunidade em 29/07/2026):
      // a trilha do lead (call_track) é classificação por renda e NÃO muda aqui

      let eq = { obs: '', campos: [], historico: [] };
      let temColunaEquipe = true;
      let atendenteLead = '';
      const rc2 = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=equipe_json,atendente&limit=1`, { headers: H });
      if (rc2.ok) {
        const row = (await rc2.json())[0] || {};
        if (semPermissao(row.atendente)) return erroBloqueio(row.atendente);
        atendenteLead = String(row.atendente || '').trim();
        try { const p = JSON.parse(row.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* começa vazio */ }
      } else temColunaEquipe = false;

      const quando = emISO
        ? new Date(emISO).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'data a confirmar';
      eq.historico.unshift({ t: new Date().toISOString(), quem: quem2, txt: 'Agendou pelo painel: ' + quando });
      eq.historico = eq.historico.slice(0, 60);

      const patch = { agendado: true, status: 'agendado', agendamento_em: emISO, agendamento_status: '', etapa: 'agendado', updated_at: new Date().toISOString() };
      if (uid) patch.booking_uid = uid;
      if (temColunaEquipe) patch.equipe_json = JSON.stringify(eq);
      const gravar = () => fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      let rg = await gravar();
      // colunas do CRM podem não existir → grava o essencial mesmo assim
      if (!rg.ok) { delete patch.equipe_json; delete patch.agendamento_status; delete patch.etapa; temColunaEquipe = false; rg = await gravar(); }
      if (rg.ok) await moverNoKanban(ref, atendenteLead, 'agendado');   // o funil acompanha
      return json({ ok: rg.ok, equipe_json: temColunaEquipe ? JSON.stringify(eq) : '' });
    }

    /* ---------- PÓS-VENDA: dados da conversão + recebimento pelo CS ---------- */
    if (body.action === 'venda' || body.action === 'recebido') {
      const quemV = auth.user.nome || 'Equipe';
      const rv = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=atendente,resultado,venda_json,equipe_json&limit=1`, { headers: H });
      if (!rv.ok) return json({ ok: false, error: 'Falta rodar o setup-posvenda.sql no Supabase (módulo Pós-Venda).' });
      const lead = (await rv.json())[0] || {};
      // podem mexer: administradora, o atendente responsável ou a equipe de CS
      if (!auth.admin && !auth.cs && semPermissao(lead.atendente)) return erroBloqueio(lead.atendente);
      if ((lead.resultado || '') !== 'convertido') return json({ ok: false, error: 'Este lead ainda não está marcado como Convertido.' });

      let venda = {};
      try { const p = JSON.parse(lead.venda_json || ''); if (p && typeof p === 'object') venda = p; } catch { /* vazio */ }
      let eq = { obs: '', campos: [], historico: [] };
      try { const p = JSON.parse(lead.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* vazio */ }
      const hist2 = (txt) => { eq.historico.unshift({ t: new Date().toISOString(), quem: quemV, txt }); eq.historico = eq.historico.slice(0, 60); };

      if (body.action === 'venda') {
        const v = body.venda || {};
        if ('cpf' in v) venda.cpf = String(v.cpf || '').trim().slice(0, 30);
        if ('endereco' in v) venda.endereco = String(v.endereco || '').trim().slice(0, 400);
        if ('produto' in v) venda.produto = String(v.produto || '').trim().slice(0, 120);
        if ('valor' in v) venda.valor = Math.max(0, Number(v.valor) || 0);
        if (Array.isArray(v.pagamentos)) {
          venda.pagamentos = v.pagamentos.slice(0, 10).map((p) => ({
            forma: String((p && p.forma) || '').trim().slice(0, 40),
            valor: Math.max(0, Number(p && p.valor) || 0),
          })).filter((p) => p.forma || p.valor);
        }
        if ('cs_nome' in v) {
          venda.cs_nome = String(v.cs_nome || '').trim().slice(0, 120);
          if (venda.cs_nome) hist2('Pós-venda: responsável CS definido — ' + venda.cs_nome);
        }
        hist2('Pós-venda: dados da venda atualizados' + (venda.produto ? ' (' + venda.produto + ')' : ''));
      } else {
        // RECEBIDO pelo CS: só com o cadastro completo (regra do item 6)
        if (!auth.admin && !auth.cs) return json({ ok: false, error: 'Somente a administradora ou usuários com Função CS podem marcar como Recebido.' });
        const faltas = [];
        if (!venda.cpf) faltas.push('CPF/CNPJ');
        if (!venda.endereco) faltas.push('endereço');
        if (!venda.produto) faltas.push('produto');
        if (!(Number(venda.valor) > 0)) faltas.push('valor');
        if (!Array.isArray(venda.pagamentos) || !venda.pagamentos.length) faltas.push('forma de pagamento');
        if (faltas.length) return json({ ok: false, error: 'Antes de marcar como Recebido, complete os dados da venda: ' + faltas.join(', ') + '.' });
        venda.recebido_em = new Date().toISOString();
        venda.recebido_por = quemV;
        if (!venda.cs_nome) venda.cs_nome = quemV;
        hist2('Pós-venda: RECEBIDO pelo CS (' + quemV + ')');
      }

      const rp = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ venda_json: JSON.stringify(venda), equipe_json: JSON.stringify(eq), updated_at: new Date().toISOString() }),
      });
      if (!rp.ok) return json({ ok: false, error: 'Falta rodar o setup-posvenda.sql no Supabase (módulo Pós-Venda).' });
      return json({ ok: true, venda_json: JSON.stringify(venda), equipe_json: JSON.stringify(eq) });
    }

    /* ---------- ATUALIZAR campos do lead ---------- */
    const c = body.campos || {};
    const quem = auth.user.nome || 'Equipe';

    // estado atual (pra mesclar anotações e montar o histórico)
    let temColunaResultado = true;
    let temColunaEtapa = true;
    let rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=nome,atendente,agendamento_status,agendamento_em,resultado,etapa,equipe_json&limit=1`, { headers: H });
    if (!rc.ok) {
      temColunaEtapa = false;       // coluna etapa pode não existir ainda (setup-kanban3)
      rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=nome,atendente,agendamento_status,agendamento_em,resultado,equipe_json&limit=1`, { headers: H });
    }
    if (!rc.ok) {
      temColunaResultado = false;   // coluna resultado pode não existir ainda
      rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}&select=nome,atendente,agendamento_status,agendamento_em,equipe_json&limit=1`, { headers: H });
    }
    let atual = {};
    let temColunaEquipe = true;
    if (rc.ok) atual = (await rc.json())[0] || {};
    else temColunaEquipe = false;   // coluna equipe_json pode não existir ainda

    // lead de outro atendente: nada pode ser alterado (nem o responsável)
    if (semPermissao(atual.atendente)) return erroBloqueio(atual.atendente);

    if (!temColunaEquipe && ('obs' in c || Array.isArray(c.campos_extras))) {
      return json({ ok: false, error: AVISO_SQL });
    }

    let eq = { obs: '', campos: [], historico: [] };
    try { const p = JSON.parse(atual.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* começa vazio */ }
    const hist = (txt) => eq.historico.unshift({ t: new Date().toISOString(), quem, txt });

    const patch = { updated_at: new Date().toISOString() };
    let mexeuEquipe = false;

    let mudouAtendente = false;
    if ('atendente' in c) {
      patch.atendente = String(c.atendente || '').trim().slice(0, 120);
      if (patch.atendente !== (atual.atendente || '')) {
        hist('Atendente responsável: ' + (patch.atendente || '(nenhum)'));
        mexeuEquipe = true;
        mudouAtendente = true;
        // atribuição move o funil: lead entra (ou sai) da etapa Atribuído
        if (temColunaEtapa && !(atual.resultado || '')) patch.etapa = patch.atendente ? 'atribuido' : '';
      }
    }
    let mudouEtapa = null;   // etapa alterada manualmente no cartão
    if ('etapa' in c) {
      const et = String(c.etapa || '').trim();
      if (!ETAPAS_VALIDAS.includes(et)) return json({ ok: false, error: 'etapa inválida' });
      if (!temColunaEtapa) return json({ ok: false, error: 'Falta rodar o setup-kanban3.sql no Supabase (funil inteligente).' });
      const etReal = et === 'novo' ? '' : et;
      if (etReal !== (atual.etapa || '')) {
        patch.etapa = etReal;
        mudouEtapa = etReal;
        const rotulos = { '': 'Novo', atribuido: 'Atribuído', conversa: 'Em Conversa', agendado: 'Agendado' };
        hist('Status: ' + rotulos[etReal] + ' (alterado no cartão)');
        mexeuEquipe = true;
      }
    }
    let alertaPresenca = null;   // criado no fim, se a presença foi registrada
    if ('agendamento_status' in c) {
      const st = String(c.agendamento_status || '').trim();
      if (!STATUS_VALIDOS.includes(st)) return json({ ok: false, error: 'status inválido' });
      patch.agendamento_status = st;
      if (st !== (atual.agendamento_status || '')) {
        const rotulos = { '': 'confirmado', concluido: 'concluído', reagendado: 'reagendado', cancelado: 'cancelado', compareceu: 'COMPARECEU ✓', nao_compareceu: 'NÃO COMPARECEU ✕' };
        hist((st === 'compareceu' || st === 'nao_compareceu' ? 'Presença: ' : 'Agendamento: ') + (rotulos[st] || st));
        mexeuEquipe = true;
        // presença registrada → alerta automático: pro responsável, ou pra
        // TODA a equipe quando o lead ainda não tem atendente (atendente vazio)
        const destinatario = ('atendente' in c ? patch.atendente : (atual.atendente || '')).trim();
        if (st === 'compareceu' || st === 'nao_compareceu') {
          const quando = atual.agendamento_em
            ? new Date(atual.agendamento_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : 'data não registrada';
          alertaPresenca = {
            lead_ref: ref,
            lead_nome: atual.nome || '',
            atendente: destinatario,
            tipo: 'presenca',
            descricao: (st === 'compareceu' ? '✓ Compareceu' : '✕ NÃO compareceu') + ' ao Encontro de ' + quando + '. Registrado por ' + quem + '.'
              + (destinatario ? '' : ' Lead SEM atendente — para toda a equipe.'),
            data_hora: atual.agendamento_em || null,
            status: 'pendente',
          };
        }
      }
    }
    if ('resultado' in c) {
      if (!temColunaResultado) return json({ ok: false, error: 'Falta rodar o setup-resultado.sql no Supabase (colunas de convertido/perdido).' });
      const rs = String(c.resultado || '').trim();
      if (!['', 'convertido', 'perdido'].includes(rs)) return json({ ok: false, error: 'resultado inválido' });
      const atualRes = atual.resultado || '';
      if (rs !== atualRes) {
        // reativar um convertido/perdido é ação exclusiva da administradora
        if (rs === '' && atualRes && !auth.admin) {
          return json({ ok: false, error: 'Somente a administradora pode reativar um lead convertido ou perdido.' });
        }
        const motivo = String(c.resultado_motivo || '').trim().slice(0, 300);
        patch.resultado = rs;
        patch.resultado_em = rs ? new Date().toISOString() : null;
        patch.resultado_por = rs ? quem : '';
        patch.resultado_motivo = rs === 'perdido' ? motivo : '';
        if (temColunaEtapa && rs) patch.etapa = '';   // convertido/perdido saem das etapas ativas
        hist(rs === 'convertido' ? '✓ Lead CONVERTIDO'
          : rs === 'perdido' ? ('✕ Lead PERDIDO' + (motivo ? ' — motivo: ' + motivo : ''))
          : 'Lead reativado (voltou para os ativos)');
        mexeuEquipe = true;
      }
    }
    if ('obs' in c) {
      eq.obs = String(c.obs || '').slice(0, 3000);
      hist('Atualizou as observações');
      mexeuEquipe = true;
    }
    if (Array.isArray(c.campos_extras)) {
      eq.campos = c.campos_extras.slice(0, 20).map((f) => ({
        k: String((f && f.k) || '').trim().slice(0, 60),
        v: String((f && f.v) || '').trim().slice(0, 400),
      })).filter((f) => f.k || f.v);
      hist('Atualizou os campos personalizados');
      mexeuEquipe = true;
    }

    if (Object.keys(patch).length === 1 && !mexeuEquipe) return json({ ok: false, error: 'nada para alterar' });

    eq.historico = eq.historico.slice(0, 60);
    if (mexeuEquipe && temColunaEquipe) patch.equipe_json = JSON.stringify(eq);

    const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?lead_ref=eq.${refUrl}`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (/equipe_json/i.test(t)) return json({ ok: false, error: AVISO_SQL });
      return json({ ok: false, error: 'erro ao salvar' });
    }
    if (alertaPresenca) {
      try {
        await fetch(`${SB_URL}/rest/v1/alertas`, {
          method: 'POST',
          headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify(alertaPresenca),
        });
      } catch { /* alerta é melhor-esforço; a presença já foi salva */ }
    }
    // o quadro Kanban do responsável acompanha a mudança (melhor-esforço)
    const atendenteFinal = 'atendente' in c ? patch.atendente : (atual.atendente || '');
    if (mudouAtendente) {
      await moverNoKanban(ref, atendenteFinal, (atual.resultado || '') ? atual.resultado : 'atribuido');
    } else if (patch.resultado) {
      await moverNoKanban(ref, atendenteFinal, patch.resultado);
    } else if (mudouEtapa !== null) {
      await moverNoKanban(ref, atendenteFinal, mudouEtapa === '' ? 'atribuido' : mudouEtapa);
    } else if (patch.resultado !== undefined) {
      await moverNoKanban(ref, atendenteFinal, 'atribuido');   // reativado sem etapa definida
    }
    return json({
      ok: true,
      equipe_json: temColunaEquipe ? JSON.stringify(eq) : '',
      resultado_em: patch.resultado_em !== undefined ? patch.resultado_em : undefined,
      resultado_por: patch.resultado_por !== undefined ? patch.resultado_por : undefined,
      resultado_motivo: patch.resultado_motivo !== undefined ? patch.resultado_motivo : undefined,
    });
  } catch (e) {
    console.error('lead-admin:', e?.message || e);
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

export const config = { path: '/api/lead-admin' };
