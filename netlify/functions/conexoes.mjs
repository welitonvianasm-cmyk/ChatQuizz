/**
 * CONEXÕES CONFIGURÁVEIS PELO PAINEL — Cal.com (chave usada pelo "Espelho
 * do Cal" e pelo status mostrado no quiz) e MentoriaHub (espelho global
 * de leads num CRM externo). Segredos nunca são devolvidos ao navegador —
 * só se está configurado ou não (mesmo princípio de senha: escreve, nunca
 * lê de volta em texto puro).
 *
 *   POST /api/conexoes { token, action:'status' }
 *     → { ok, calcom: { temEnv, temSalva, conectado }, mentoriahub: { conectado } }
 *   POST /api/conexoes { token, action:'salvar_calcom', api_key }   (admin)
 *   POST /api/conexoes { token, action:'remover_calcom' }           (admin)
 *   POST /api/conexoes { token, action:'salvar_mentoriahub', url, secret, ativo }   (admin)
 *   POST /api/conexoes { token, action:'remover_mentoriahub' }                      (admin)
 *   POST /api/conexoes { token, action:'google_calendarios' }                       (admin)
 *   POST /api/conexoes { token, action:'google_salvar_calendario', calendarId }     (admin)
 *   POST /api/conexoes { token, action:'google_desconectar' }                       (admin)
 *
 * (a conexão do Google Agenda em si é feita via /api/google-oauth — este
 * arquivo só cuida do "resto": listar calendários, escolher um, desconectar)
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { lerConexaoCalcom, salvarConexaoCalcom, obterConexaoMentoriaHub, salvarConexaoMentoriaHub, lerConexaoGoogleAgenda, salvarConexaoGoogleAgenda } from '../_conexoes.mjs';
import { listarCalendariosGoogle } from '../_googleAgenda.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  try {
    const a = body.action;

    if (a === 'status') {
      const salvo = await lerConexaoCalcom(contaId);
      const temEnv = !!process.env.CALCOM_API_KEY;
      const temSalva = !!salvo.api_key;
      const mentoriahub = await obterConexaoMentoriaHub(contaId);
      const google = await lerConexaoGoogleAgenda(contaId);
      return json({
        ok: true,
        calcom: { temEnv, temSalva, conectado: temEnv || temSalva },
        mentoriahub: { conectado: !!mentoriahub },
        google: { conectado: !!google.refreshToken, email: google.email || '', calendarId: google.calendarId || '' },
      });
    }

    if (!auth.admin) return json({ ok: false, error: 'Somente a administradora gerencia conexões.' });

    if (a === 'salvar_calcom') {
      const api_key = String(body.api_key || '').trim().slice(0, 300);
      if (!api_key) return json({ ok: false, error: 'Cole a chave da API do Cal.com.' });
      await salvarConexaoCalcom(contaId, { api_key });
      return json({ ok: true });
    }

    if (a === 'remover_calcom') {
      await salvarConexaoCalcom(contaId, {});
      return json({ ok: true });
    }

    if (a === 'salvar_mentoriahub') {
      const url = String(body.url || '').trim().slice(0, 500);
      const secret = String(body.secret || '').trim().slice(0, 300);
      if (!url) return json({ ok: false, error: 'Cole a URL do webhook do MentoriaHub.' });
      await salvarConexaoMentoriaHub(contaId, { url, secret, ativo: body.ativo !== false });
      return json({ ok: true });
    }

    if (a === 'remover_mentoriahub') {
      await salvarConexaoMentoriaHub(contaId, {});
      return json({ ok: true });
    }

    if (a === 'google_calendarios') {
      try {
        const lista = await listarCalendariosGoogle(contaId);
        return json({ ok: true, calendarios: lista });
      } catch (e) {
        console.error('conexoes google_calendarios:', e?.message || e);
        return json({ ok: false, error: 'Não consegui listar os calendários — tente reconectar o Google Agenda.' });
      }
    }

    if (a === 'google_salvar_calendario') {
      const calendarId = String(body.calendarId || '').trim().slice(0, 300);
      if (!calendarId) return json({ ok: false, error: 'Escolha um calendário.' });
      const existente = await lerConexaoGoogleAgenda(contaId);
      if (!existente.refreshToken) return json({ ok: false, error: 'Conecte o Google Agenda primeiro.' });
      await salvarConexaoGoogleAgenda(contaId, { ...existente, calendarId });
      return json({ ok: true });
    }

    if (a === 'google_desconectar') {
      await salvarConexaoGoogleAgenda(contaId, {});
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('conexoes:', e?.message || e);
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

export const config = { path: '/api/conexoes' };
