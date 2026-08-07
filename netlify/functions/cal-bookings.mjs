/**
 * Espelho dos agendamentos do Cal (aba "Espelho do Cal" do painel).
 * Puxa direto da API OFICIAL do cal.com (v2) com a chave da Suely —
 * fonte da verdade: inclui bookings feitos fora do funil e o status real.
 * Protegido pelas senhas do painel.
 *
 *   GET /api/cal-bookings → { ok, count, bookings:[{uid,eventTypeId,evento,start,end,created,status,attendee,attendeesCount}] }
 */
import { temConfig, autenticar } from '../_tokens.mjs';
const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSAO = '2024-08-13';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  if (!temConfig()) return json({ error: 'DASHBOARD_TOKEN not configured' }, 503);
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiKey) return json({ error: 'CALCOM_API_KEY not configured' }, 500);

  let body = {};
  try { if (req.method === 'POST') body = await req.json(); } catch { /* sem body */ }
  const token = req.headers.get('x-dash-token') || body.token || '';
  const auth = await autenticar(token);
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  try {
    // pagina a lista oficial (até 1000 bookings)
    const arr = [];
    for (let skip = 0; skip < 1000; skip += 250) {
      const r = await fetch(`${CAL_API}/bookings?take=250&skip=${skip}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': CAL_VERSAO },
      });
      if (!r.ok) {
        if (skip === 0) { console.error('cal-bookings:', r.status, await r.text().catch(() => '')); return json({ ok: false, reason: 'cal_error' }, 502); }
        break;
      }
      const data = await r.json();
      const pagina = Array.isArray(data?.data) ? data.data : [];
      arr.push(...pagina);
      if (pagina.length < 250) break;
    }
    const bookings = arr.map((b) => {
      const at = Array.isArray(b.attendees) ? b.attendees : [];
      // título vem "Nome do evento entre X e Y" (ou "between X and Y") — fica só o nome do evento
      const evento = String(b.title || '').split(/\s+(?:entre|between)\s+/i)[0].trim() || ('Evento #' + (b.eventTypeId ?? '?'));
      return {
        uid: b.uid || '',
        eventTypeId: b.eventTypeId ?? null,
        evento,
        start: b.startTime || b.start || '',
        end: b.endTime || '',
        created: b.createdAt || b.created || '',
        status: b.status || '',
        attendee: (at[0] && at[0].name) || '',
        attendeesCount: at.length,
      };
    });
    return json({ ok: true, count: bookings.length, bookings });
  } catch (err) {
    console.error('cal-bookings error:', err?.message || err);
    return json({ ok: false, reason: 'error' }, 500);
  }
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-dash-token',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/cal-bookings' };
