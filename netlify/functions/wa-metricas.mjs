/**
 * MÉTRICAS DE WHATSAPP pro Visão Geral — "Taxa de resposta" e "Tempo de
 * resposta" (quanto tempo o lead demora pra responder depois que a gente
 * manda mensagem) e "Tipo de resposta" (texto/áudio/mídia/figurinha).
 *
 *   POST /api/wa-metricas { token, desde?, ate? } → { ok, respondeu, tipos }
 *
 * Só é chamado pelo painel quando a conta tem esse KPI habilitado (ver
 * kpis-config.mjs) — evita o custo de ler wa_mensagens inteiro pra quem
 * não usa. `desde`/`ate` (ISO) filtram por `criado_em`; sem eles, olha
 * tudo (mesma convenção do período "Tudo" do resto do painel).
 *
 * Definição de "respondeu": olhando lead por lead, achar a 1ª mensagem
 * NOSSA ('out') e ver se depois dela veio alguma mensagem DELE ('in') —
 * mede "o lead responde quando a gente manda mensagem", não qualquer
 * mensagem recebida (um lead que só manda mensagem por iniciativa própria,
 * sem a gente nunca ter mandado nada, não entra no denominador).
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const TIPOS_VALIDOS = ['texto', 'audio', 'imagem', 'documento', 'video', 'figurinha', 'outro'];

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
    let filtro = `conta_id=eq.${contaId}`;
    if (body.desde) filtro += `&criado_em=gte.${encodeURIComponent(body.desde)}`;
    if (body.ate) filtro += `&criado_em=lte.${encodeURIComponent(body.ate)}`;

    // paginação simples, mesmo teto de segurança usado em metrics.mjs
    const PAGE = 1000;
    const MAX_PAGES = 50;
    let msgs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const to = from + PAGE - 1;
      const r = await fetch(
        `${SB_URL}/rest/v1/wa_mensagens?${filtro}&select=lead_ref,direcao,tipo,criado_em&order=criado_em.asc`,
        { headers: { ...H, Range: `${from}-${to}`, 'Range-Unit': 'items' } },
      );
      if (!r.ok) {
        const errText = await r.text();
        console.error('wa-metricas read error:', r.status, errText.slice(0, 200));
        return json({ ok: false, error: 'Falta rodar o setup-kpi-atendimento.sql no Supabase (coluna tipo em wa_mensagens).' });
      }
      const batch = await r.json();
      msgs = msgs.concat(batch);
      if (batch.length < PAGE) break;
    }

    // agrupa por lead_ref (mensagens sem lead vinculado não contam pra
    // "responde quando a gente manda mensagem" — não tem como saber se é
    // a mesma pessoa em contatos diferentes)
    const porLead = new Map();
    for (const m of msgs) {
      if (!m.lead_ref) continue;
      if (!porLead.has(m.lead_ref)) porLead.set(m.lead_ref, []);
      porLead.get(m.lead_ref).push(m);
    }

    let comMensagemEnviada = 0;
    let responderam = 0;
    let somaMinutos = 0;
    for (const lista of porLead.values()) {
      const primeiroOut = lista.find((m) => m.direcao === 'out');
      if (!primeiroOut) continue;
      comMensagemEnviada++;
      const tOut = new Date(primeiroOut.criado_em).getTime();
      const resposta = lista.find((m) => m.direcao === 'in' && new Date(m.criado_em).getTime() > tOut);
      if (resposta) {
        responderam++;
        somaMinutos += (new Date(resposta.criado_em).getTime() - tOut) / 60000;
      }
    }

    // contagem por tipo — só mensagens recebidas (o que o LEAD mandou)
    const tipos = Object.fromEntries(TIPOS_VALIDOS.map((t) => [t, 0]));
    for (const m of msgs) {
      if (m.direcao !== 'in') continue;
      const t = TIPOS_VALIDOS.includes(m.tipo) ? m.tipo : 'outro';
      tipos[t]++;
    }

    return json({
      ok: true,
      respondeu: {
        total: comMensagemEnviada,
        responderam,
        taxa: comMensagemEnviada ? responderam / comMensagemEnviada : 0,
        tempoMedioMin: responderam ? Math.round(somaMinutos / responderam) : null,
      },
      tipos,
    });
  } catch (e) {
    console.error('wa-metricas:', e?.message || e);
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

export const config = { path: '/api/wa-metricas' };
