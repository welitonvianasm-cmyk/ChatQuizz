/**
 * WEBHOOK da Evolution API — recebe as mensagens do WhatsApp em tempo real.
 * Configurado na Evolution apontando para:
 *   https://quiz-suavitatis.netlify.app/api/wa-webhook?t=<WA_WEBHOOK_SECRET>
 *
 * Grava cada mensagem em wa_mensagens e tenta casar o telefone com um lead.
 * Env: WA_WEBHOOK_SECRET (segredo do webhook — recusa chamadas sem ele).
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const SECRET = process.env.WA_WEBHOOK_SECRET || '';

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
      const telefone = jid.replace(/\D/g, '');
      const texto = (d.message && (d.message.conversation || (d.message.extendedTextMessage && d.message.extendedTextMessage.text))) || '';
      if (!telefone || !texto) continue;
      const direcao = d.key.fromMe ? 'out' : 'in';
      const wa_id = String(d.key.id || '');

      // casa o telefone com um lead (sufixo de 10-11 dígitos cobre DDI/9º dígito)
      let lead_ref = '';
      try {
        const fim = telefone.slice(-10);
        const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?whatsapp=ilike.*${fim}&select=lead_ref&limit=1`, { headers: H });
        if (rl.ok) { const rows = await rl.json(); lead_ref = (rows[0] && rows[0].lead_ref) || ''; }
      } catch { /* sem vínculo */ }

      await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
        method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ telefone, lead_ref, direcao, texto: String(texto).slice(0, 4000), wa_id, lida: direcao === 'out' }),
      });
    }
    return new Response('ok');
  } catch (e) {
    console.error('wa-webhook:', e?.message || e);
    return new Response('ok');   // nunca derruba o webhook da Evolution
  }
};

export const config = { path: '/api/wa-webhook' };
