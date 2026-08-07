/**
 * MOTOR DE AGENDAMENTO INVISÍVEL — proxy da API interna do Cal (<sua-instancia-cal>/interno).
 * O lead nunca vê o Cal.com: a agenda inline do funil consulta horários reais e
 * cria o booking de verdade por aqui. O booking dispara o webhook do Cal →
 * integração calcom-sprinthub existente joga o lead no funil Comercial.
 *
 * ── Contrato da API interna (descoberto em 2026-06-14) ──
 *   Auth: header  Authorization: Bearer <CALCOM_API_KEY>   (sem cal-api-version)
 *   GET  /event-types                         → { data:[{id,title,slug,length,...}] }
 *   GET  /slots?eventTypeId&from&to&timeZone   → { data:{ slots:{ 'YYYY-MM-DD':[{time:ISO}] } } }
 *   POST /bookings  {eventTypeId,start,name,email,timeZone,phone?,metadata?}
 *   GET  /bookings/{uid}                       → { data:{ uid,startTime,status,attendees,... } }
 *
 * Actions deste proxy:
 *   { action:'route', renda, nicho, bio }              → { ok, track, vendor, vendorEventTypeId, embedLink }
 *   { action:'slots', start:'YYYY-MM-DD', end, vendorEventTypeId? } → { ok, slots, iso, track, vendor, vendorEventTypeId }
 *   { action:'book',  start:ISO, nome, email, whatsapp, vendorEventTypeId? } → { ok, uid, start, videoUrl, track, vendor }
 *   { action:'info',  uid }                            → { ok, nome, start, status, videoUrl }
 *
 * Env: CALCOM_API_KEY, CALCOM_BASE_URL (=https://<sua-instancia-cal>/interno),
 *      CALCOM_EVENT_TYPE_ID (event type único da trilha PADRÃO — opcional, ligar depois),
 *      CALCOM_EVENT_TYPE_ID_AUDIENCE (trilha 10k+ NÃO-médico → "Conheça o Método Core Audience"),
 *      CAL_EMBED_VENDEDORES (override do pool premium, JSON).
 * Sem CALCOM_API_KEY → actions de slots/book/info devolvem {ok:false,reason:'no_key'} e o funil usa a agenda local.
 */
import { CAL_BASE as PRIV_CAL_BASE, VENDEDORES } from '../_private.mjs';
const TZ = 'America/Sao_Paulo';

/* Base da API interna (proxy próprio do Fabio). NÃO leva /v2. */
const CAL_BASE = (process.env.CALCOM_BASE_URL || PRIV_CAL_BASE).replace(/\/+$/, '');

/* Supabase (mesmo projeto do funil) — usado só pra reaproveitar o link de
   vídeo do 1º booking de um horário em GRUPO (seats): nos assentos seguintes
   a API do Cal não devolve o videoCallUrl, então buscamos pelo booking_uid. */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';

/* ================================================================
   ROTEAMENTO DE LEADS → qual reunião (regra do Fabio). 3 trilhas:
   PREMIUM:  médico 10k+/mês  OU  qualquer um 50k+/mês → pool de closers.
   AUDIENCE: NÃO-médico de 10k a 50k/mês → "Call de Raio X" (CALCOM_EVENT_TYPE_ID_AUDIENCE).
   PADRÃO:   resto (<10k, médico ou não) → CALCOM_EVENT_TYPE_ID ou agenda local.
   ================================================================ */
const REGRA_PREMIUM = {
  rendas: ['R$10 a 20 mil/mês', 'R$20 a 50 mil/mês', 'Acima de R$50 mil/mês'],
  nichos: ['Saúde & Bem-estar'],
  // Detecção de médico pela bio. Sinais FORTES e específicos:
  //  • CRM + número (licença médica; todo médico publica por exigência do CFM)
  //    aceita "CRM-SP 166680" · "CRM/RJ 9876" · "CRM 12345-MG" · "CRMSP123"
  //  • "médic(o/a)" / "medicin(a)" + as especialidades mais comuns (stems)
  //  • "nutrólog(o)" = médico (≠ "nutricionista", que NÃO casa de propósito)
  // NÃO usa "Dr./Dra." sozinho: ambíguo (advogado, dentista, PhD, uso retórico).
  bioMedica: /\b(m[eé]dic[oa]|medicin|crm[\s/:.\-]*[a-z]{0,3}[\s/:.\-]*\d|cardiologi|dermatologi|ginecologi|obstetr|pediatr|ortopedi|psiquiatr|neurologi|endocrin|oftalmologi|otorrino|urologi|nutr[oó]log|anestesi|radiologi|cirurgi[ãa])/i,
};

export function escolherTrilha({ renda, nicho, bio }) {
  const r = String(renda || '');
  const is50plus = r === 'Acima de R$50 mil/mês';
  const is10a50 = r === 'R$10 a 20 mil/mês' || r === 'R$20 a 50 mil/mês';
  const rendaAlta = is50plus || is10a50;          // 10k+/mês
  const ehMedico = REGRA_PREMIUM.nichos.includes(String(nicho || '')) ||
    REGRA_PREMIUM.bioMedica.test(String(bio || ''));
  // PREMIUM (closers): médico 10k+  OU  qualquer um 50k+
  if ((ehMedico && rendaAlta) || is50plus) return 'premium';
  // AUDIENCE → Call de Raio X: NÃO-médico de 10k a 50k
  if (is10a50) return 'audience';
  // PADRÃO → resto (<10k, médico ou não)
  return 'padrao';
}

/* ================================================================
   POOL DE VENDEDORES por trilha — uma fonte só pro embed (link) E pra
   API (eventTypeId). Sorteio ponderado: percent = fatia fixa; os demais
   dividem o restante igual. Hoje SEM percent em ninguém = 25% pra cada um dos 4 (divisão igual).
   Override via env CAL_EMBED_VENDEDORES (JSON, mesmo formato).
   ================================================================ */
const VENDEDORES_DEFAULT = VENDEDORES;

export function vendedoresDaTrilha(trilha) {
  let lista = VENDEDORES_DEFAULT;
  try {
    if (process.env.CAL_EMBED_VENDEDORES) lista = JSON.parse(process.env.CAL_EMBED_VENDEDORES);
  } catch (e) { console.error('CAL_EMBED_VENDEDORES: JSON inválido'); }
  return (Array.isArray(lista) ? lista : []).filter((v) => v && String(v.trilha || 'padrao') === trilha);
}

export function sortearVendedor(lista, rnd = Math.random()) {
  if (!lista.length) return null;
  const fixos = lista.filter((v) => +v.percent > 0);
  const usado = fixos.reduce((s, v) => s + +v.percent, 0);
  const livres = lista.length - fixos.length;
  const restante = Math.max(0, 100 - usado);
  const fatias = lista.map((v) => +v.percent > 0 ? +v.percent : (livres ? restante / livres : 0));
  const total = fatias.reduce((a, b) => a + b, 0) || 1;
  let r = rnd * total;
  for (let i = 0; i < lista.length; i++) {
    r -= fatias[i];
    if (r <= 0) return lista[i];
  }
  return lista[lista.length - 1];
}

/* lê o closer prioritário definido no painel (funnel_config). '' = sorteio normal. */
async function lerCloserPrioritario() {
  if (!SB_URL || !SB_KEY) return '';
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.closer_prioritario&select=value&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) return '';
    const rows = await r.json();
    return (rows && rows[0] && rows[0].value) ? String(rows[0].value).trim() : '';
  } catch { return ''; }
}

/* escolhe o vendedor da trilha. Ordem: (1) já sorteado [consistência slot↔book];
   (2) closer PRIORITÁRIO do painel; (3) sorteio ponderado. {eventTypeId,vendor,link} ou null. */
async function resolverVendedor(trilha, vendorEventTypeId) {
  const lista = vendedoresDaTrilha(trilha);
  if (lista.length) {
    let v = lista.find((x) => +x.eventTypeId === +(vendorEventTypeId || 0));   // 1) consistência
    if (!v) {                                                                  // 2) prioridade manual
      const forced = await lerCloserPrioritario();
      if (forced) v = lista.find((x) => +x.eventTypeId === +forced);
    }
    if (!v) v = sortearVendedor(lista);                                        // 3) sorteio
    return { eventTypeId: +v.eventTypeId, vendor: v.nome || '', link: v.link || '' };
  }
  // trilha sem pool → event type único por env
  const envId =
    trilha === 'premium'  ? (process.env.CALCOM_EVENT_TYPE_ID_PREMIUM || process.env.CALCOM_EVENT_TYPE_ID) :
    trilha === 'audience' ? process.env.CALCOM_EVENT_TYPE_ID_AUDIENCE :
                            process.env.CALCOM_EVENT_TYPE_ID;
  return envId ? { eventTypeId: +envId, vendor: '', link: '' } : null;
}

async function calGet(path, apiKey) {
  return fetch(`${CAL_BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const apiKey = process.env.CALCOM_API_KEY;

  try {
    const body = await req.json();
    const trilha = escolherTrilha(body);

    /* ---------- ROUTE: decide trilha + vendedor uma vez (front salva no lead).
       Funciona SEM a API (devolve embedLink p/ fallback). ---------- */
    if (body.action === 'route') {
      const v = await resolverVendedor(trilha, body.vendorEventTypeId);
      return json({
        ok: true, track: trilha,
        vendor: v?.vendor || '',
        vendorEventTypeId: v?.eventTypeId || null,
        embedLink: v?.link || (trilha === 'premium'
          ? (process.env.CAL_EMBED_LINK_PREMIUM || process.env.CAL_EMBED_LINK || '')
          : (process.env.CAL_EMBED_LINK || '')),
      });
    }

    /* actions de API real exigem a chave */
    if (!apiKey) return json({ ok: false, reason: 'no_key' });

    /* ---------- INFO: só precisa do uid (independe de trilha/vendedor) ---------- */
    if (body.action === 'info') {
      if (!body.uid) return json({ ok: false, reason: 'missing_uid' });
      const r = await calGet(`/bookings/${encodeURIComponent(body.uid)}`, apiKey);
      if (!r.ok) return json({ ok: false, reason: 'not_found' });
      const data = await r.json().catch(() => ({}));
      const b = data?.data ?? data;
      return json({
        ok: true,
        nome: b?.attendees?.[0]?.name || '',
        start: b?.startTime || b?.start || '',
        status: b?.status || '',
        videoUrl: extrairVideoUrl(b),
      });
    }

    const v = await resolverVendedor(trilha, body.vendorEventTypeId);
    if (!v) return json({ ok: false, reason: 'no_event', track: trilha });
    const eventTypeId = v.eventTypeId;
    const vendor = v.vendor;

    /* ---------- SLOTS: disponibilidade real ---------- */
    if (body.action === 'slots') {
      const from = `${body.start}T00:00:00.000Z`;
      const to = `${body.end}T23:59:59.999Z`;
      const r = await calGet(
        `/slots?eventTypeId=${encodeURIComponent(eventTypeId)}` +
        `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
        `&timeZone=${encodeURIComponent(TZ)}`, apiKey);
      if (!r.ok) {
        console.error('cal slots error:', r.status, await r.text().catch(() => ''));
        return json({ ok: false, reason: 'cal_error' });
      }
      const data = await r.json();
      const raw = data?.data?.slots ?? data?.slots ?? data?.data ?? {};
      // normaliza pra { 'yyyy-mm-dd': ['HH:MM', ...] } + iso[dia][hora] no fuso de SP
      const fmtH = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
      const fmtD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
      const slots = {}, iso = {};
      for (const k of Object.keys(raw)) {
        const arr = Array.isArray(raw[k]) ? raw[k] : [];
        for (const item of arr) {
          const t = typeof item === 'string' ? item : (item.time || item.start || '');
          if (!t) continue;
          const dt = new Date(t);
          if (isNaN(dt)) continue;
          const dKey = fmtD.format(dt);
          const hKey = fmtH.format(dt);
          (slots[dKey] = slots[dKey] || []).push(hKey);
          (iso[dKey] = iso[dKey] || {})[hKey] = dt.toISOString();
        }
      }
      for (const k of Object.keys(slots)) slots[k] = [...new Set(slots[k])].sort();
      return json({ ok: true, slots, iso, track: trilha, vendor, vendorEventTypeId: eventTypeId });
    }

    /* ---------- BOOK: cria o booking real (invisível pro lead) ---------- */
    if (body.action === 'book') {
      const { start, nome, email, whatsapp, metadata } = body;
      if (!start || !nome || !email) return json({ ok: false, reason: 'missing_fields' });

      const payload = {
        eventTypeId: Number(eventTypeId),
        start: new Date(start).toISOString(),
        name: String(nome).slice(0, 120),
        email: String(email).slice(0, 200),
        timeZone: TZ,
        language: 'pt',
        ...(whatsapp ? { phone: '+' + String(whatsapp).replace(/\D/g, '') } : {}),
        ...(metadata && typeof metadata === 'object' ? { metadata: slimMeta(metadata) } : {}),
      };

      const r = await fetch(`${CAL_BASE}/bookings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('cal book error:', r.status, JSON.stringify(data).slice(0, 400));
        const msg = JSON.stringify(data).toLowerCase();
        const reason = msg.includes('already') || msg.includes('not available') || msg.includes('taken') ? 'slot_taken' : 'cal_error';
        return json({ ok: false, reason });
      }
      const b = data?.data ?? data;
      const uid = b?.uid || b?.id || '';
      let videoUrl = extrairVideoUrl(b);
      // call em grupo (seats): nos assentos 2+ o Cal não devolve o link →
      // reaproveita o do 1º booking do mesmo horário (mesmo booking_uid).
      if (!videoUrl && uid) videoUrl = await buscarVideoUrlPorUid(uid);
      return json({
        ok: true,
        uid,
        start: b?.startTime || b?.start || payload.start,
        videoUrl,
        track: trilha,
        vendor,
      });
    }

    return json({ ok: false, reason: 'unknown_action' }, 400);
  } catch (err) {
    console.error('agenda error:', err?.message || err);
    return json({ ok: false, reason: 'error' });
  }
};

/* busca o link de vídeo de um booking já salvo no Supabase pelo booking_uid —
   usado pra entregar o mesmo link aos assentos seguintes de uma call em grupo. */
async function buscarVideoUrlPorUid(uid) {
  if (!SB_URL || !SB_KEY || !uid) return '';
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/diag_instagram_leads?booking_uid=eq.${encodeURIComponent(uid)}&select=video_url&limit=20`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return '';
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : [])
      .map((x) => x.video_url)
      .find((v) => /^https?:\/\//.test(v || '')) || '';
  } catch { return ''; }
}

/* o link da sala muda de lugar conforme o tipo de local do event type;
   na API interna o location costuma vir como "integrations:daily" (sem URL) —
   nesse caso devolve '' e o lead recebe o link pela confirmação do Cal. */
function extrairVideoUrl(b) {
  if (!b || typeof b !== 'object') return '';
  // a API interna entrega o link no topo (videoCallUrl) na resposta do POST /bookings
  if (typeof b.videoCallUrl === 'string' && /^https?:\/\//.test(b.videoCallUrl)) return b.videoCallUrl;
  if (b.metadata?.videoCallUrl) return b.metadata.videoCallUrl;
  if (typeof b.location === 'string' && /^https?:\/\//.test(b.location)) return b.location;
  if (typeof b.meetingUrl === 'string') return b.meetingUrl;
  const ref = Array.isArray(b.references) ? b.references.find((x) => x?.meetingUrl) : null;
  return ref?.meetingUrl || '';
}

function slimMeta(m) {
  const out = {};
  for (const k of Object.keys(m).slice(0, 10)) out[String(k).slice(0, 40)] = String(m[k] ?? '').slice(0, 200);
  return out;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export const config = { path: '/api/agenda' };
