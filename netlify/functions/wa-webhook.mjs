/**
 * WEBHOOK da Evolution API — recebe as mensagens do WhatsApp em tempo real.
 * Configurado na Evolution apontando para:
 *   https://SEU-SITE.netlify.app/api/wa-webhook?t=<WA_WEBHOOK_SECRET>
 * (isso já é feito automaticamente ao conectar o WhatsApp pelo painel)
 *
 * Grava cada mensagem em wa_mensagens e tenta casar o telefone com um lead.
 * Env: WA_WEBHOOK_SECRET (segredo do webhook — recusa chamadas sem ele).
 *
 * MULTI-TENANT: desde o WhatsApp virar multi-instância (cada conta conecta
 * seu(s) próprio(s) número(s), ver netlify/_evolution.mjs), o tenant é
 * resolvido primeiro pelo campo "instance" que a própria Evolution manda no
 * payload do webhook (nome da instância → conta_id, via wa_instancias).
 * Só cai no fallback antigo (achar por telefone já cadastrado num lead, ou
 * "primeira conta ativa") se a instância não bater com nenhuma cadastrada
 * — não deveria acontecer no uso normal, é rede de segurança.
 *
 * Env opcional: AGENTE_SDR_WEBHOOK_URL — se configurada, toda mensagem
 * RECEBIDA (direção 'in') é encaminhada pra essa URL, fire-and-forget,
 * pra um agente externo de SDR/IA poder responder por fora do painel.
 * Sem essa env, esse encaminhamento simplesmente não acontece.
 *
 * AGENTE IA PRÓPRIO (Fase 3): toda mensagem de TEXTO recebida também é
 * despachada, fire-and-forget, pro netlify/functions/agente-processar.mjs
 * do próprio site — ele decide sozinho se tem agente ativo/não pausado
 * pra essa conta e responde por conta própria. Não é awaited de propósito:
 * assim o processamento (chamada da Claude + ferramentas + envio) roda
 * numa invocação de function separada, com seu PRÓPRIO orçamento de tempo,
 * em vez de somar ao tempo deste webhook (que precisa responder rápido
 * pra Evolution não re-tentar a entrega).
 */
import { marcarPrimeiroAtendimento } from '../_kpi.mjs';
import { normalizarTelefoneBR, obterContaPorInstancia } from '../_evolution.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const SECRET = process.env.WA_WEBHOOK_SECRET || '';
const SDR_WEBHOOK_URL = process.env.AGENTE_SDR_WEBHOOK_URL || '';
const SITE_URL = (process.env.URL || '').replace(/\/+$/, '');

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

    // interessa o evento de mensagem (messages.upsert); o resto é ignorado
    const ev = String(body.event || '').toLowerCase();
    if (!ev.includes('messages')) return new Response('ok');
    const dados = Array.isArray(body.data) ? body.data : [body.data];

    for (const d of dados) {
      if (!d || !d.key) continue;
      const jid = String(d.key.remoteJid || '');
      if (!jid.endsWith('@s.whatsapp.net')) continue;      // só conversas 1:1 (ignora grupos)
      const telefone = normalizarTelefoneBR(jid.replace(/\D/g, ''));
      const pushName = String(d.pushName || '').trim().slice(0, 120);
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
      const nomeInstancia = String(body.instance || '').trim();

      // 1) tenant pelo nome da instância (o normal, desde o multi-instância)
      let contaId = nomeInstancia ? await obterContaPorInstancia(nomeInstancia) : null;
      // 2) sem bater (instância não cadastrada, ou ainda em transição): casa
      //    pelo telefone já vinculado a um lead (sufixo de 10-11 dígitos cobre DDI/9º dígito)
      let lead_ref = '';
      let nomeLead = '';
      let emailLead = '';
      if (!contaId) {
        try {
          const fim = telefone.slice(-10);
          const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?whatsapp=ilike.*${fim}&select=lead_ref,conta_id,nome,email&limit=1`, { headers: H });
          if (rl.ok) { const rows = await rl.json(); if (rows[0]) { lead_ref = rows[0].lead_ref || ''; contaId = rows[0].conta_id; nomeLead = rows[0].nome || ''; emailLead = rows[0].email || ''; } }
        } catch { /* sem vínculo */ }
      } else {
        // achou pela instância — ainda assim tenta achar o lead_ref, só que já escopado pela conta certa
        try {
          const fim = telefone.slice(-10);
          const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&whatsapp=ilike.*${fim}&select=lead_ref,nome,email&limit=1`, { headers: H });
          if (rl.ok) { const rows = await rl.json(); if (rows[0]) { lead_ref = rows[0].lead_ref || ''; nomeLead = rows[0].nome || ''; emailLead = rows[0].email || ''; } }
        } catch { /* sem vínculo */ }
      }
      if (!contaId) contaId = await contaPadrao();
      if (!contaId) continue;   // nenhuma conta cadastrada ainda — nada a fazer

      const linhaMsg = { conta_id: contaId, telefone, lead_ref, direcao, tipo, texto: String(texto).slice(0, 4000), wa_id, lida: direcao === 'out', push_name: pushName, instancia: nomeInstancia };
      const rIns = await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(linhaMsg),
      });
      if (!rIns.ok) {
        const errText = await rIns.text().catch(() => '');
        // colunas push_name/instancia podem não existir ainda (falta rodar
        // setup-wa-nome-contato.sql / setup-wa-multi-instancia.sql) — tira a
        // que faltar e tenta de novo, sem perder a mensagem por causa disso
        let mexeu = false;
        if (/push_name/i.test(errText) && 'push_name' in linhaMsg) { delete linhaMsg.push_name; mexeu = true; }
        if (/instancia/i.test(errText) && 'instancia' in linhaMsg) { delete linhaMsg.instancia; mexeu = true; }
        if (mexeu) {
          await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
            method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(linhaMsg),
          });
        } else {
          console.error('wa-webhook insert error:', rIns.status, errText.slice(0, 200));
        }
      }
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

      // Agente IA próprio (Fase 3) — despacha em paralelo, sem esperar
      // (ver nota no topo do arquivo). agente-processar.mjs decide sozinho
      // se tem agente ativo/não pausado; aqui só entrega o necessário.
      if (direcao === 'in' && texto && nomeInstancia && SITE_URL) {
        fetch(`${SITE_URL}/api/agente-processar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contaId, telefone, leadRef: lead_ref, texto, instanciaNome: nomeInstancia, nomeLead, emailLead }),
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
