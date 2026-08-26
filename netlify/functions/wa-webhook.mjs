/**
 * WEBHOOK da Evolution API — recebe as mensagens do WhatsApp em tempo real.
 * Configurado na Evolution apontando para:
 *   https://SEU-SITE.netlify.app/api/wa-webhook?t=<WA_WEBHOOK_SECRET>
 * (isso já é feito automaticamente ao conectar o WhatsApp pelo painel)
 *
 * Grava cada mensagem em wa_mensagens e tenta casar o telefone com um lead.
 * Env: WA_WEBHOOK_SECRET (segredo do webhook — recusa chamadas sem ele).
 *
 * MULTI-TENANT: a instância Evolution ainda é global (uma só pra todas as
 * contas — ver nota em whatsapp.mjs/wa-cron.mjs), então a mensagem em si
 * não vem marcada com conta nenhuma. Resolve pelo lead já cadastrado com
 * esse telefone (o lead JÁ tem conta_id); sem lead conhecido, cai na
 * primeira conta ativa (mesmo fallback usado nos endpoints públicos).
 *
 * Env opcional: AGENTE_SDR_WEBHOOK_URL — se configurada, toda mensagem
 * RECEBIDA (direção 'in') é encaminhada pra essa URL, fire-and-forget,
 * pra um agente externo de SDR/IA poder responder por fora do painel.
 * Sem essa env, esse encaminhamento simplesmente não acontece.
 */
import { marcarPrimeiroAtendimento } from '../_kpi.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const SECRET = process.env.WA_WEBHOOK_SECRET || '';
const SDR_WEBHOOK_URL = process.env.AGENTE_SDR_WEBHOOK_URL || '';

let CONTA_PADRAO_CACHE = null;
async function contaPadrao() {
  if (CONTA_PADRAO_CACHE) return CONTA_PADRAO_CACHE;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/contas?status=eq.ativa&select=id&order=id.asc&limit=1`, { headers: H });
    if (r.ok) { const rows = await r.json(); if (rows[0]) { CONTA_PADRAO_CACHE = rows[0].id; return rows[0].id; } }
  } catch { /* sem conta nenhuma cadastrada ainda */ }
  return null;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  try {
    const url = new URL(req.url);
    if (!SECRET || url.searchParams.get('t') !== SECRET) return new Response('unauthorized', { status: 401 });
    const body = await req.json().catch(() => ({}));

    // DIAGNÓSTICO TEMPORÁRIO (2026-08-26): confirmar o formato real do payload
    // nesta versão da Evolution antes de decidir se o parser abaixo precisa mudar.
    console.log('wa-webhook payload:', JSON.stringify(body).slice(0, 3000));

    // interessa o evento de mensagem (messages.upsert); o resto é ignorado
    const ev = String(body.event || '').toLowerCase();
    if (!ev.includes('messages')) return new Response('ok');
    const dados = Array.isArray(body.data) ? body.data : [body.data];

    for (const d of dados) {
      if (!d || !d.key) continue;
      const jid = String(d.key.remoteJid || '');
      if (!jid.endsWith('@s.whatsapp.net')) continue;      // só conversas 1:1 (ignora grupos)
      const telefone = jid.replace(/\D/g, '');
      // tipo da mensagem (formato da resposta do lead) — texto tem o conteúdo
      // extraído normalmente; os demais tipos são gravados sem texto (só a
      // contagem por tipo importa pro KPI, não o conteúdo em si por enquanto).
      let texto = '';
      let tipo = 'outro';
      if (d.message) {
        if (d.message.conversation) { texto = d.message.conversation; tipo = 'texto'; }
        else if (d.message.extendedTextMessage && d.message.extendedTextMessage.text) { texto = d.message.extendedTextMessage.text; tipo = 'texto'; }
        else if (d.message.audioMessage) tipo = 'audio';
        else if (d.message.imageMessage) tipo = 'imagem';
        else if (d.message.documentMessage) tipo = 'documento';
        else if (d.message.videoMessage) tipo = 'video';
        else if (d.message.stickerMessage) tipo = 'figurinha';   // sticker é campo próprio no Baileys, não cai em imageMessage
      }
      if (!telefone || !d.message) continue;   // antes também exigia texto, o que descartava áudio/mídia antes até de gravar
      const direcao = d.key.fromMe ? 'out' : 'in';
      const wa_id = String(d.key.id || '');

      // casa o telefone com um lead (sufixo de 10-11 dígitos cobre DDI/9º dígito)
      // — o lead já vem com a conta_id certa, é o que resolve o tenant da mensagem
      let lead_ref = '';
      let contaId = null;
      try {
        const fim = telefone.slice(-10);
        const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?whatsapp=ilike.*${fim}&select=lead_ref,conta_id&limit=1`, { headers: H });
        if (rl.ok) { const rows = await rl.json(); if (rows[0]) { lead_ref = rows[0].lead_ref || ''; contaId = rows[0].conta_id; } }
      } catch { /* sem vínculo */ }
      if (!contaId) contaId = await contaPadrao();
      if (!contaId) continue;   // nenhuma conta cadastrada ainda — nada a fazer

      await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ conta_id: contaId, telefone, lead_ref, direcao, tipo, texto: String(texto).slice(0, 4000), wa_id, lida: direcao === 'out' }),
      });
      if (lead_ref) marcarPrimeiroAtendimento(contaId, lead_ref, 'conversa');

      // encaminha mensagens de TEXTO recebidas pro agente externo (SDR/IA),
      // se configurado — best-effort, nunca atrapalha o webhook em si.
      // Continua exigindo `texto` aqui de propósito: o agente ainda só sabe
      // processar texto, e antes dessa mudança áudio/mídia nunca chegava
      // até aqui mesmo (era descartado antes de gravar em wa_mensagens).
      if (direcao === 'in' && texto && SDR_WEBHOOK_URL) {
        fetch(SDR_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telefone, texto, wa_id, contaId, lead_ref }),
        }).catch(() => {});
      }
    }
    return new Response('ok');
  } catch (e) {
    console.error('wa-webhook:', e?.message || e);
    return new Response('ok');   // nunca derruba o webhook da Evolution
  }
};

export const config = { path: '/api/wa-webhook' };
