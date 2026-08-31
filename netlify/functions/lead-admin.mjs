/**
 * Ações da equipe sobre leads (qualquer usuário autenticado do painel):
 *
 *   POST /api/lead-admin { token, lead_ref, campos: { atendente?, agendamento_status?, obs?, campos_extras? } }
 *     → { ok, equipe_json }   (equipe_json = anotações/campos/histórico atualizados)
 *   POST /api/lead-admin { token, action:'excluir', lead_ref }
 *     → { ok }   (remove o lead da base e dos quadros Kanban)
 *   POST /api/lead-admin { token, action:'criar', lead: { nome, whatsapp?, email?, uf?, renda?, atendente? } }
 *     → { ok, lead }   (cadastro manual pelo painel — ex: botão "+ Novo Lead" do Quadro)
 *   POST /api/lead-admin { token, action:'remarcar', lead_ref, agendamento_em }
 *     → { ok, agendamento_em, booking_uid }   (novo dia/horário — se tiver booking_uid,
 *        remarca de verdade via API do Cal.com antes de gravar aqui; cancela o
 *        lembrete "1h antes" pendente do horário antigo)
 *
 * equipe_json (coluna no lead) = { obs, campos:[{k,v}], historico:[{t,quem,txt}] }
 * O histórico é preenchido AUTOMATICAMENTE a cada mudança, com o nome de quem fez.
 *
 * Cancelar o agendamento (agendamento_status:'cancelado') também cancela o
 * lembrete "1h antes" pendente desse lead, se houver (cancelarLembretesPendentes).
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { dispararMentoriaHub, obterCalcomApiKey } from '../_conexoes.mjs';
import { sincronizarEventoGoogle, removerEventoGoogle } from '../_googleAgenda.mjs';
import { moverNoKanban } from '../_kanban.mjs';
import { marcarPrimeiroAtendimento } from '../_kpi.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const STATUS_VALIDOS = ['', 'concluido', 'reagendado', 'cancelado', 'compareceu', 'nao_compareceu'];
/* normaliza número BR pro formato canônico 55+DDD+9 dígitos: completa o DDI
   quando falta (cadastro manual "+ Novo Lead"/"Editar", sem seletor de país
   — o quiz público já resolve isso sozinho) e completa o 9º dígito do
   celular quando falta (mesmo número pode chegar como 12 ou 13 dígitos
   dependendo de quem digitou/mandou — sem isso a Evolution/WhatsApp recusa
   o envio, ou o número não bate com o que já tá salvo). Guarda com "+" na
   frente, mesmo formato E.164 já usado por save-lead.mjs. Mesma lógica
   (sem o "+") em whatsapp.mjs/wa-webhook.mjs/webhook-pagamento.mjs. */
function comDDI(whatsapp) {
  const d = String(whatsapp || '').replace(/\D/g, '');
  if (!d) return '';
  let resto;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) resto = d.slice(2);
  else if (d.length === 10 || d.length === 11) resto = d;
  else return '+' + d;   // formato não reconhecido (outro país, ou incompleto) — não mexe
  const ddd = resto.slice(0, 2);
  let numero = resto.slice(2);
  if (numero.length === 8) numero = '9' + numero;
  return '+55' + ddd + numero;
}
const ETAPAS_VALIDAS = ['', 'novo', 'atribuido', 'conversa', 'agendado'];   // perdido/convertido vivem no `resultado`
const AVISO_SQL = 'Falta rodar o setup-card.sql no Supabase (coluna de anotações da equipe).';
const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSAO = '2024-08-13';

/* cancela o(s) lembrete(s) de reunião ("1h antes") ainda pendentes desse lead —
   chamado sempre que o agendamento é cancelado ou remarcado, senão o cron
   (wa-cron.mjs) manda um lembrete de uma reunião que já não vale mais.
   Não mexe no disparo de roteamento automático (origem 'roteamento_quiz'),
   que é independente da reunião. Melhor-esforço: nunca derruba a ação principal. */
async function cancelarLembretesPendentes(refUrl) {
  try {
    await fetch(`${SB_URL}/rest/v1/disparos?lead_ref=eq.${refUrl}&status=eq.pendente&origem=eq.reuniao_1h`, {
      method: 'DELETE', headers: H,
    });
  } catch { /* melhor-esforço */ }
}

/* google_event_id é coluna nova (setup-google-agenda.sql) — busca isolada
   e best-effort, nunca junto do SELECT principal do lead (senão, antes de
   rodar a migração, quebraria a leitura inteira do lead por causa de 1
   coluna só, o mesmo bug já corrigido no metrics.mjs). */
async function obterGoogleEventId(contaId, refUrl) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=google_event_id&limit=1`, { headers: H });
    if (!r.ok) return '';
    const rows = await r.json();
    return (rows[0] && rows[0].google_event_id) || '';
  } catch { return ''; }
}

/* espelha o agendamento no Google Agenda da conta (se conectada) — cria
   na 1ª vez (pedindo uma sala do Meet junto) ou atualiza se já existir
   google_event_id (sem pedir sala nova). Melhor-esforço: nunca derruba
   a ação principal do painel. Preenche video_url só se ainda tiver vazio. */
async function sincronizarAgendaGoogle(contaId, refUrl, { googleEventId, titulo, inicioISO, participanteNome, participanteEmail, videoUrlAtual }) {
  try {
    const inicio = new Date(inicioISO);
    if (isNaN(inicio)) return;
    const fimISO = new Date(inicio.getTime() + 30 * 60000).toISOString();   // duração estimada (30min) — o painel não guarda a duração real
    const resultado = await sincronizarEventoGoogle(contaId, { googleEventId: googleEventId || undefined, titulo, inicioISO, fimISO, participanteNome, participanteEmail });
    if (!resultado) return;
    const patch = {};
    if (resultado.id && resultado.id !== googleEventId) patch.google_event_id = resultado.id;
    if (resultado.meetLink && !videoUrlAtual) patch.video_url = resultado.meetLink;
    if (!Object.keys(patch).length) return;
    await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
  } catch (e) { console.error('google-agenda:', e?.message || e); }
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

  /* ---------- CRIAR lead manualmente pelo painel (Kanban → "+ Novo Lead") ---------- */
  if (body.action === 'criar') {
    try {
      const quem0 = auth.user.nome || 'Equipe';
      const d = body.lead || {};
      const nome = String(d.nome || '').trim().slice(0, 160);
      if (!nome) return json({ ok: false, error: 'Informe o nome do lead.' });
      const lead_ref = 'manual_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      const atendente = String(d.atendente || '').trim().slice(0, 120);
      const agora = new Date().toISOString();
      const eq = {
        obs: '', campos: [],
        historico: [{ t: agora, quem: quem0, txt: 'Lead cadastrado manualmente pelo painel' + (atendente ? ' — atribuído a ' + atendente : '') }],
      };
      const novo = {
        conta_id: contaId, lead_ref, nome,
        whatsapp: comDDI(d.whatsapp).slice(0, 40),
        email: String(d.email || '').trim().slice(0, 160),
        uf: String(d.uf || '').trim().slice(0, 2).toUpperCase(),
        renda: String(d.renda || '').trim().slice(0, 80),
        atendente,
        call_track: String(d.qualificador || '').trim().slice(0, 60),
        status: 'completo',
        origem: 'painel-crm',
        equipe_json: JSON.stringify(eq),
        created_at: agora, updated_at: agora,
      };
      if (atendente) novo.etapa = 'atribuido';
      let r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(novo),
      });
      if (!r.ok) {
        // colunas mais novas (etapa/equipe_json) podem não existir ainda — tenta sem elas
        delete novo.etapa; delete novo.equipe_json;
        r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(novo),
        });
      }
      if (!r.ok) {
        console.error('lead-admin criar:', await r.text().catch(() => ''));
        return json({ ok: false, error: 'Erro ao criar o lead.' });
      }
      const linha = (await r.json())[0] || novo;
      if (atendente) await moverNoKanban(contaId, lead_ref, atendente, 'atribuido');
      return json({ ok: true, lead: linha });
    } catch (e) {
      console.error('lead-admin criar:', e?.message || e);
      return json({ ok: false, error: 'error' }, 500);
    }
  }

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
      const rp = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=atendente&limit=1`, { headers: H });
      if (rp.ok) {
        const row = (await rp.json())[0] || {};
        if (semPermissao(row.atendente)) return erroBloqueio(row.atendente);
      }
      try { await fetch(`${SB_URL}/rest/v1/kanban_cards?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H }); } catch { /* melhor-esforço */ }
      try { await fetch(`${SB_URL}/rest/v1/alertas?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H }); } catch { /* melhor-esforço */ }
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H });
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
      let leadNome = '', leadEmail = '', leadVideoUrl = '';
      const rc2 = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=equipe_json,atendente,nome,email,video_url&limit=1`, { headers: H });
      if (rc2.ok) {
        const row = (await rc2.json())[0] || {};
        if (semPermissao(row.atendente)) return erroBloqueio(row.atendente);
        atendenteLead = String(row.atendente || '').trim();
        leadNome = row.nome || ''; leadEmail = row.email || ''; leadVideoUrl = row.video_url || '';
        try { const p = JSON.parse(row.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* começa vazio */ }
      } else temColunaEquipe = false;

      const quando = emISO
        ? new Date(emISO).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'data a confirmar';
      eq.historico.unshift({ t: new Date().toISOString(), quem: quem2, txt: 'Agendou pelo painel: ' + quando });
      eq.historico = eq.historico.slice(0, 60);

      const patch = { agendado: true, status: 'agendado', agendamento_em: emISO, agendamento_status: '', agendamento_origem: 'manual', etapa: 'agendado', updated_at: new Date().toISOString() };
      if (uid) patch.booking_uid = uid;
      if (temColunaEquipe) patch.equipe_json = JSON.stringify(eq);
      const gravar = () => fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      let rg = await gravar();
      // colunas do CRM podem não existir → grava o essencial mesmo assim
      if (!rg.ok) { delete patch.equipe_json; delete patch.agendamento_status; delete patch.etapa; delete patch.agendamento_origem; temColunaEquipe = false; rg = await gravar(); }
      if (rg.ok) await moverNoKanban(contaId, ref, atendenteLead, 'agendado');   // o funil acompanha
      if (rg.ok) dispararMentoriaHub(contaId, 'agendamento_confirmado', {
        chatquizzLeadRef: ref, agendamentoEm: emISO, linkReuniao: '', bookingUid: uid,
      });
      if (rg.ok && emISO) {
        const geId = await obterGoogleEventId(contaId, refUrl);
        await sincronizarAgendaGoogle(contaId, refUrl, {
          googleEventId: geId, titulo: 'Encontro com ' + (leadNome || 'lead'),
          inicioISO: emISO, participanteNome: leadNome, participanteEmail: leadEmail, videoUrlAtual: leadVideoUrl,
        });
      }
      return json({ ok: rg.ok, equipe_json: temColunaEquipe ? JSON.stringify(eq) : '' });
    }

    /* ---------- REMARCAR pelo painel (novo dia/horário pra um agendamento existente) ----------
       Sem booking_uid (agendamento manual): só atualiza a data aqui.
       Com booking_uid (veio do Cal.com): remarca de VERDADE via API oficial do
       Cal.com (POST /bookings/{uid}/reschedule) antes de tocar no nosso banco —
       se a chamada falhar, não mexe em nada aqui pra não dessincronizar os dois lados. */
    if (body.action === 'remarcar') {
      const quem3 = auth.user.nome || 'Equipe';
      const em2 = body.agendamento_em ? new Date(body.agendamento_em) : null;
      if (!em2 || isNaN(em2)) return json({ ok: false, error: 'Data/horário inválido.' });
      let emISO2 = em2.toISOString();

      let eq2 = { obs: '', campos: [], historico: [] };
      let temColunaEquipe2 = true;
      let atendenteLead2 = '';
      const rc3 = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=equipe_json,atendente,booking_uid,agendamento_em,nome,email,video_url&limit=1`, { headers: H });
      if (!rc3.ok) return json({ ok: false, error: 'Lead não encontrado.' });
      const rowAtual = (await rc3.json())[0] || {};
      if (semPermissao(rowAtual.atendente)) return erroBloqueio(rowAtual.atendente);
      atendenteLead2 = String(rowAtual.atendente || '').trim();
      try { const p = JSON.parse(rowAtual.equipe_json || ''); if (p && typeof p === 'object') eq2 = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* começa vazio */ }

      const uidAtual = String(rowAtual.booking_uid || '').trim();
      let novoUid = uidAtual;
      let viaCalcom = false;
      if (uidAtual) {
        viaCalcom = true;
        const apiKey = await obterCalcomApiKey(contaId);
        if (!apiKey) return json({ ok: false, error: 'Chave do Cal.com não configurada (aba Conexões) — não dá pra remarcar esse agendamento de verdade.' });
        let rcal;
        try {
          rcal = await fetch(`${CAL_API}/bookings/${encodeURIComponent(uidAtual)}/reschedule`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': CAL_VERSAO, 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: emISO2 }),
          });
        } catch (e) {
          return json({ ok: false, error: 'Erro de rede ao falar com o Cal.com: ' + (e?.message || e) });
        }
        if (!rcal.ok) {
          const t = await rcal.text().catch(() => '');
          console.error('lead-admin remarcar (cal.com):', rcal.status, t.slice(0, 300));
          return json({ ok: false, error: 'O Cal.com recusou a remarcação (status ' + rcal.status + '). Nada foi alterado.' });
        }
        const respCal = await rcal.json().catch(() => ({}));
        const bookingNovo = respCal?.data || respCal;
        novoUid = String(bookingNovo?.uid || uidAtual);
        const novoStart = bookingNovo?.start || bookingNovo?.startTime;
        if (novoStart) { const d3 = new Date(novoStart); if (!isNaN(d3)) emISO2 = d3.toISOString(); }
      }

      const quandoAntes = rowAtual.agendamento_em
        ? new Date(rowAtual.agendamento_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'sem data';
      const quandoDepois = new Date(emISO2).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      eq2.historico.unshift({ t: new Date().toISOString(), quem: quem3, txt: 'Remarcou pelo painel: ' + quandoAntes + ' → ' + quandoDepois + (viaCalcom ? ' (Cal.com)' : '') });
      eq2.historico = eq2.historico.slice(0, 60);

      const patch2 = { agendamento_em: emISO2, agendamento_status: '', agendamento_origem: 'manual', updated_at: new Date().toISOString() };
      if (viaCalcom) patch2.booking_uid = novoUid;
      if (temColunaEquipe2) patch2.equipe_json = JSON.stringify(eq2);
      const gravar2 = () => fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch2),
      });
      let rg2 = await gravar2();
      if (!rg2.ok) { delete patch2.equipe_json; delete patch2.agendamento_status; delete patch2.agendamento_origem; temColunaEquipe2 = false; rg2 = await gravar2(); }
      if (!rg2.ok) return json({ ok: false, error: viaCalcom ? 'A reunião foi remarcada no Cal.com, mas não consegui salvar aqui no painel — confira manualmente.' : 'Erro ao salvar.' });
      await cancelarLembretesPendentes(refUrl);
      dispararMentoriaHub(contaId, 'agendamento_reagendado', {
        chatquizzLeadRef: ref, agendamentoEm: emISO2, bookingUid: novoUid,
      });
      const geId2 = await obterGoogleEventId(contaId, refUrl);
      await sincronizarAgendaGoogle(contaId, refUrl, {
        googleEventId: geId2, titulo: 'Encontro com ' + (rowAtual.nome || 'lead'),
        inicioISO: emISO2, participanteNome: rowAtual.nome, participanteEmail: rowAtual.email, videoUrlAtual: rowAtual.video_url,
      });
      return json({ ok: true, agendamento_em: emISO2, booking_uid: novoUid, equipe_json: temColunaEquipe2 ? JSON.stringify(eq2) : '' });
    }

    /* ---------- PÓS-VENDA: dados da conversão + recebimento pelo CS ---------- */
    if (body.action === 'venda' || body.action === 'recebido') {
      const quemV = auth.user.nome || 'Equipe';
      const rv = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=atendente,resultado,venda_json,equipe_json&limit=1`, { headers: H });
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

      const rp = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
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
    let temColunasRedes = true;   // tiktok/facebook — setup-redes-sociais-lead.sql
    let rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=nome,whatsapp,email,instagram,tiktok,facebook,atendente,agendamento_status,agendamento_em,resultado,etapa,call_track,equipe_json&limit=1`, { headers: H });
    if (!rc.ok) {
      temColunasRedes = false;
      rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=nome,whatsapp,email,instagram,atendente,agendamento_status,agendamento_em,resultado,etapa,call_track,equipe_json&limit=1`, { headers: H });
    }
    if (!rc.ok) {
      temColunaEtapa = false;       // coluna etapa pode não existir ainda (setup-kanban3)
      rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=nome,whatsapp,email,instagram,atendente,agendamento_status,agendamento_em,resultado,call_track,equipe_json&limit=1`, { headers: H });
    }
    if (!rc.ok) {
      temColunaResultado = false;   // coluna resultado pode não existir ainda
      rc = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&select=nome,whatsapp,email,instagram,atendente,agendamento_status,agendamento_em,call_track,equipe_json&limit=1`, { headers: H });
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

    if ('nome' in c) {
      const novoNome = String(c.nome || '').trim().slice(0, 160);
      if (!novoNome) return json({ ok: false, error: 'O nome não pode ficar vazio.' });
      if (novoNome !== (atual.nome || '')) { patch.nome = novoNome; hist('Nome alterado para "' + novoNome + '"'); mexeuEquipe = true; }
    }
    if ('whatsapp' in c) {
      const novoWhats = comDDI(c.whatsapp);
      if (novoWhats !== (atual.whatsapp || '')) { patch.whatsapp = novoWhats; hist('WhatsApp corrigido'); mexeuEquipe = true; }
    }
    if ('email' in c) {
      const novoEmail = String(c.email || '').trim().slice(0, 160);
      if (novoEmail !== (atual.email || '')) { patch.email = novoEmail; hist('E-mail corrigido'); mexeuEquipe = true; }
    }
    if ('instagram' in c) {
      const novo = String(c.instagram || '').trim().slice(0, 60);
      if (novo !== (atual.instagram || '')) { patch.instagram = novo; hist('Instagram atualizado'); mexeuEquipe = true; }
    }
    if ('tiktok' in c && temColunasRedes) {
      const novo = String(c.tiktok || '').trim().slice(0, 60);
      if (novo !== (atual.tiktok || '')) { patch.tiktok = novo; hist('TikTok atualizado'); mexeuEquipe = true; }
    }
    if ('facebook' in c && temColunasRedes) {
      const novo = String(c.facebook || '').trim().slice(0, 60);
      if (novo !== (atual.facebook || '')) { patch.facebook = novo; hist('Facebook atualizado'); mexeuEquipe = true; }
    }
    if ('qualificador' in c) {
      const novo = String(c.qualificador || '').trim().slice(0, 60);
      if (novo !== (atual.call_track || '')) { patch.call_track = novo; hist('Qualificador atualizado'); mexeuEquipe = true; }
    }

    let mudouAtendente = false;
    if ('atendente' in c) {
      patch.atendente = String(c.atendente || '').trim().slice(0, 120);
      if (patch.atendente !== (atual.atendente || '')) {
        hist('Atendente responsável: ' + (patch.atendente || '(nenhum)'));
        mexeuEquipe = true;
        mudouAtendente = true;
        // reserva do KPI "tempo até 1º atendimento": só grava se nenhuma
        // conversa real (wa-webhook.mjs) já tiver gravado antes
        if (patch.atendente) marcarPrimeiroAtendimento(contaId, ref, 'atribuicao');
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
    let cancelarLembrete = false;   // true → mata o lembrete "1h antes" pendente, no fim
    if ('agendamento_status' in c) {
      const st = String(c.agendamento_status || '').trim();
      if (!STATUS_VALIDOS.includes(st)) return json({ ok: false, error: 'status inválido' });
      // ARMADILHA (não é bug hoje — nada aqui chama a API do Cal.com, é só
      // status local): se um dia "cancelado" passar a cancelar de verdade a
      // reserva no Cal.com, tomar cuidado com Encontros em grupo (agenda.mjs
      // já lida com "seats" — várias pessoas compartilhando UM booking_uid).
      // Cancelar pelo uid derruba todo mundo do grupo, não só esse lead.
      // Ver o fix real desse mesmo bug no reagendar do quiz-suavitatis
      // (commit bc1ee2a, 2026-08-31): só cancela no Cal.com se nenhum outro
      // lead com esse booking_uid ainda tiver agendamento_status ativo.
      patch.agendamento_status = st;
      if (st !== (atual.agendamento_status || '')) {
        const rotulos = { '': 'confirmado', concluido: 'concluído', reagendado: 'reagendado', cancelado: 'cancelado', compareceu: 'COMPARECEU ✓', nao_compareceu: 'NÃO COMPARECEU ✕' };
        hist((st === 'compareceu' || st === 'nao_compareceu' ? 'Presença: ' : 'Agendamento: ') + (rotulos[st] || st));
        mexeuEquipe = true;
        if (st === 'cancelado') cancelarLembrete = true;
        // presença registrada → alerta automático: pro responsável, ou pra
        // TODA a equipe quando o lead ainda não tem atendente (atendente vazio)
        const destinatario = ('atendente' in c ? patch.atendente : (atual.atendente || '')).trim();
        if (st === 'compareceu' || st === 'nao_compareceu') {
          const quando = atual.agendamento_em
            ? new Date(atual.agendamento_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : 'data não registrada';
          alertaPresenca = {
            conta_id: contaId,
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

    const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
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
    if (cancelarLembrete) {
      await cancelarLembretesPendentes(refUrl);
      const geId3 = await obterGoogleEventId(contaId, refUrl);
      if (geId3) await removerEventoGoogle(contaId, geId3);
    }
    // o quadro Kanban do responsável acompanha a mudança (melhor-esforço)
    const atendenteFinal = 'atendente' in c ? patch.atendente : (atual.atendente || '');
    if (mudouAtendente) {
      await moverNoKanban(contaId, ref, atendenteFinal, (atual.resultado || '') ? atual.resultado : 'atribuido');
    } else if (patch.resultado) {
      await moverNoKanban(contaId, ref, atendenteFinal, patch.resultado);
    } else if (mudouEtapa !== null) {
      await moverNoKanban(contaId, ref, atendenteFinal, mudouEtapa === '' ? 'atribuido' : mudouEtapa);
    } else if (patch.resultado !== undefined) {
      await moverNoKanban(contaId, ref, atendenteFinal, 'atribuido');   // reativado sem etapa definida
    }
    return json({
      ok: true,
      equipe_json: temColunaEquipe ? JSON.stringify(eq) : '',
      resultado_em: patch.resultado_em !== undefined ? patch.resultado_em : undefined,
      resultado_por: patch.resultado_por !== undefined ? patch.resultado_por : undefined,
      resultado_motivo: patch.resultado_motivo !== undefined ? patch.resultado_motivo : undefined,
      whatsapp: patch.whatsapp !== undefined ? patch.whatsapp : undefined,
      instagram: patch.instagram !== undefined ? patch.instagram : undefined,
      tiktok: patch.tiktok !== undefined ? patch.tiktok : undefined,
      facebook: patch.facebook !== undefined ? patch.facebook : undefined,
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
