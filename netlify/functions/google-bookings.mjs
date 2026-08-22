/**
 * Espelho de LEITURA dos eventos da Google Agenda conectada (aba
 * "Reuniões → Google Agenda" do painel) — mostra o que foi marcado
 * DIRETO lá, sem passar pelo Cal.com nem pelo painel. A exclusão dos
 * eventos que já são o espelho de um agendamento nosso (mesmo id salvo
 * em google_event_id em algum lead) é feita por quem chama (dashboard.html);
 * aqui só devolve a lista crua do mês pedido.
 *
 *   POST /api/google-bookings { token, mes, ano } → { ok, eventos:[{id,titulo,inicio,fim,linkReuniao}] }
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { listarEventosGoogle } from '../_googleAgenda.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  const mes = Number(body.mes);
  const ano = Number(body.ano);
  if (!mes || !ano) return json({ ok: false, error: 'mes/ano obrigatórios' });

  try {
    const eventos = await listarEventosGoogle(contaId, mes, ano);
    return json({ ok: true, eventos });
  } catch (e) {
    console.error('google-bookings:', e?.message || e);
    return json({ ok: false, error: 'error' }, 500);
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

export const config = { path: '/api/google-bookings' };
