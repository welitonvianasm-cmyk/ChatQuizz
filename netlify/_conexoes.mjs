/* ====================================================================
   Conexões configuráveis pelo painel (Cal.com, MentoriaHub) — sempre
   escopadas por conta (multi-tenant): `funnel_config` tem chave
   primária composta (conta_id, key), então TODA função aqui exige
   `contaId` como parâmetro.
   Guardado em funnel_config (mesmo padrão já usado no resto do
   projeto), nunca devolvido de volta pro navegador em texto puro.
   ==================================================================== */
import { createHmac, randomBytes } from 'node:crypto';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE_CALCOM = 'conexao_calcom';

export async function lerConexaoCalcom(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE_CALCOM}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoCalcom(contaId, dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ conta_id: contaId, key: CHAVE_CALCOM, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

/* CALCOM_API_KEY (env var) não faz mais sentido como "prioridade global"
   em multi-tenant (seria a chave de UM cliente só) — cada conta usa a
   própria chave salva pelo painel. A env var só serve como fallback pra
   conta 0 (compatibilidade com quem já configurava assim antes desta
   migração). */
export async function obterCalcomApiKey(contaId) {
  const salvo = await lerConexaoCalcom(contaId);
  if (salvo.api_key) return salvo.api_key;
  if (contaId === 1 || contaId === '1') return process.env.CALCOM_API_KEY || '';
  return '';
}

/* ====================================================================
   Conexão MentoriaHub — espelho global de leads (CRM externo do
   cliente), por conta. Diferente do Cal.com/roteamento por qualificador:
   uma vez ligada, TODO lead qualificado (e todo agendamento, automático
   ou manual) daquela conta é enviado pra lá, sem depender de qualificador.
   ==================================================================== */
const CHAVE_MENTORIAHUB = 'conexao_mentoriahub';

export async function lerConexaoMentoriaHub(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE_MENTORIAHUB}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoMentoriaHub(contaId, dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ conta_id: contaId, key: CHAVE_MENTORIAHUB, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

/* {url, secret} só se estiver configurada e ativa; null senão (dispara nada) */
export async function obterConexaoMentoriaHub(contaId) {
  const c = await lerConexaoMentoriaHub(contaId);
  if (!c.url || c.ativo === false) return null;
  return { url: c.url, secret: c.secret || '' };
}

/* Dispara um evento pro MentoriaHub da CONTA indicada, fire-and-forget —
   nunca deixa um problema de rede/CRM externo atrapalhar quem chamou
   (quiz público ou ação do painel). */
export async function dispararMentoriaHub(contaId, evento, dados) {
  try {
    const conexao = await obterConexaoMentoriaHub(contaId);
    if (!conexao) return;
    const payload = { evento, ...dados, disparadoEm: new Date().toISOString() };
    const corpo = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (conexao.secret) {
      const assinatura = createHmac('sha256', conexao.secret).update(corpo).digest('hex');
      headers['X-ChatQuizz-Signature'] = `sha256=${assinatura}`;
    }
    fetch(conexao.url, { method: 'POST', headers, body: corpo })
      .catch((e) => console.warn('[mentoriahub webhook] falhou (seguindo normal):', evento, e.message));
  } catch (e) {
    console.warn('[mentoriahub webhook] erro ao montar disparo (seguindo normal):', evento, e?.message || e);
  }
}

/* ====================================================================
   Conexão Google Agenda — espelho de eventos (não é uma "vitrine" de
   agendamento, isso continua sendo o Cal.com). Guarda os tokens OAuth
   por conta; a troca/renovação de token acontece em netlify/_googleAgenda.mjs,
   que também usa lerConexaoGoogleAgenda/salvarConexaoGoogleAgenda daqui
   pra persistir o access_token renovado a cada chamada (função sem
   estado — não dá pra confiar em um listener "vivo" como faria um
   servidor de longa duração).
   ==================================================================== */
const CHAVE_GOOGLE_AGENDA = 'conexao_google_agenda';

export async function lerConexaoGoogleAgenda(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE_GOOGLE_AGENDA}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoGoogleAgenda(contaId, dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ conta_id: contaId, key: CHAVE_GOOGLE_AGENDA, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

/* ====================================================================
   Conexão do Webhook de Pagamento (MAKE) — diferente do Cal.com/
   MentoriaHub, o segredo aqui é GERADO pelo próprio painel (não digitado
   pelo usuário), só pra montar a URL que a conta cola na plataforma de
   pagamento/MAKE. Por isso é devolvido em texto puro pra tela de
   Conexões: escondê-lo do próprio dono da conta não protegeria nada
   (foi o painel dele mesmo que gerou), e ele precisa poder copiar de
   novo a qualquer momento, não só na hora que gerou.
   ==================================================================== */
const CHAVE_WEBHOOK_PAGAMENTO = 'conexao_webhook_pagamento';

export async function lerConexaoWebhookPagamento(contaId) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE_WEBHOOK_PAGAMENTO}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoWebhookPagamento(contaId, dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ conta_id: contaId, key: CHAVE_WEBHOOK_PAGAMENTO, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

/* gera (ou regenera, invalidando o anterior) o segredo da conta e já salva */
export async function gerarSegredoWebhookPagamento(contaId) {
  const segredo = randomBytes(24).toString('hex');
  await salvarConexaoWebhookPagamento(contaId, { segredo });
  return segredo;
}
