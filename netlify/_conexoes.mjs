/* ====================================================================
   Conexões configuráveis pelo painel (hoje: Cal.com). A chave pode vir
   de variável de ambiente (CALCOM_API_KEY) OU ser salva pelo painel
   (aba Configurações → Conexões) — a variável de ambiente sempre tem
   prioridade, pra não atrapalhar quem já configura por lá.
   Guardado em funnel_config (mesmo padrão já usado no resto do
   projeto), nunca devolvido de volta pro navegador em texto puro.
   ==================================================================== */
import { createHmac } from 'node:crypto';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE_CALCOM = 'conexao_calcom';

export async function lerConexaoCalcom() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE_CALCOM}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoCalcom(dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: CHAVE_CALCOM, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

export async function obterCalcomApiKey() {
  if (process.env.CALCOM_API_KEY) return process.env.CALCOM_API_KEY;
  const salvo = await lerConexaoCalcom();
  return salvo.api_key || '';
}

/* ====================================================================
   Conexão MentoriaHub — espelho global de leads (CRM externo do
   cliente). Diferente do Cal.com/roteamento por qualificador: uma vez
   ligada, TODO lead qualificado (e todo agendamento, automático ou
   manual) é enviado pra lá, sem depender de qualificador nenhum.
   ==================================================================== */
const CHAVE_MENTORIAHUB = 'conexao_mentoriahub';

export async function lerConexaoMentoriaHub() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE_MENTORIAHUB}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoMentoriaHub(dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: CHAVE_MENTORIAHUB, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

/* {url, secret} só se estiver configurada e ativa; null senão (dispara nada) */
export async function obterConexaoMentoriaHub() {
  const c = await lerConexaoMentoriaHub();
  if (!c.url || c.ativo === false) return null;
  return { url: c.url, secret: c.secret || '' };
}

/* Dispara um evento pro MentoriaHub, fire-and-forget — nunca deixa um
   problema de rede/CRM externo atrapalhar quem chamou (quiz público ou
   ação do painel). Usado tanto por save-lead.mjs quanto por
   lead-admin.mjs, pra não duplicar a lógica de assinatura. */
export async function dispararMentoriaHub(evento, dados) {
  try {
    const conexao = await obterConexaoMentoriaHub();
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
