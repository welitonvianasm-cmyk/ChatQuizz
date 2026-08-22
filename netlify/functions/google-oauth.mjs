/**
 * OAUTH DO GOOGLE AGENDA — conecta a conta Google que vai receber o
 * espelho dos agendamentos (ver netlify/_googleAgenda.mjs).
 *
 *   POST /api/google-oauth { token, action:'auth' }   (admin)
 *     → { ok, url }   (o painel redireciona o navegador pra essa URL)
 *
 *   GET  /api/google-oauth?code=...&state=...   (o próprio Google chama,
 *     depois do consentimento) → troca o code pelos tokens, salva a
 *     conexão e redireciona de volta pro painel (?google=conectado|erro).
 *
 * O `state` carrega o contaId ASSINADO (HMAC com o GOOGLE_CLIENT_SECRET)
 * — sem isso, alguém poderia iniciar o próprio fluxo OAuth (fora do
 * painel, direto pro Google) forjando um contaId alheio no `state` e
 * vincular a PRÓPRIA conta Google à conta de outra pessoa. Só é possível
 * gerar um `state` válido depois de autenticar com um x-dash-token de
 * administradora de verdade (branch action:'auth' abaixo).
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *      GOOGLE_REDIRECT_URI (= <seu-site>/api/google-oauth, cadastrada
 *      também nas credenciais OAuth do Google Cloud Console).
 */
import { createHmac } from 'node:crypto';
import { google } from 'googleapis';
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { criarOAuthClient } from '../_googleAgenda.mjs';
import { salvarConexaoGoogleAgenda, lerConexaoGoogleAgenda } from '../_conexoes.mjs';

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SITE_URL = (process.env.URL || '').replace(/\/+$/, '');
// calendar = acesso à agenda; userinfo.email = só pra identificar QUAL conta
// conectou (mostrar o e-mail no painel) — sem essa 2ª, oauth2.userinfo.get()
// falha com "missing required authentication credential" (o token fica sem
// nenhuma permissão de identidade, e esse endpoint legado do Google trata
// isso como se não houvesse credencial nenhuma, em vez de erro de escopo).
const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email'];

function assinarState(contaId) {
  const sig = createHmac('sha256', CLIENT_SECRET).update(String(contaId)).digest('hex').slice(0, 24);
  return `${contaId}.${sig}`;
}
function verificarState(state) {
  const [contaIdStr, sig] = String(state || '').split('.');
  if (!contaIdStr || !sig) return null;
  const esperado = createHmac('sha256', CLIENT_SECRET).update(contaIdStr).digest('hex').slice(0, 24);
  if (sig.length !== esperado.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ esperado.charCodeAt(i);
  if (diff !== 0) return null;
  const n = Number(contaIdStr);
  return Number.isFinite(n) ? n : contaIdStr;
}

async function tratarCallback(url) {
  const destino = (msg) => Response.redirect(`${SITE_URL}/dashboard.html?google=${msg}`, 302);
  const erro = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const contaId = erro ? null : verificarState(url.searchParams.get('state'));
  if (erro || !code || contaId == null) return destino('erro');

  try {
    const client = criarOAuthClient();
    const { tokens } = await client.getToken(code);   // isso é o essencial — se falhar, não tem conexão pra salvar mesmo
    client.setCredentials(tokens);

    // e-mail é só pra exibição no painel — melhor-esforço, nunca descarta
    // os tokens (que já foram obtidos com sucesso) se essa parte falhar
    let perfil = {};
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      perfil = (await oauth2.userinfo.get()).data || {};
    } catch (e) {
      console.warn('google-oauth callback (userinfo, seguindo mesmo assim):', e?.message || e);
    }

    const existente = await lerConexaoGoogleAgenda(contaId);
    await salvarConexaoGoogleAgenda(contaId, {
      ...existente,
      // o Google só reenvia refresh_token no 1º consentimento (ou reconsentimento
      // forçado) — se não vier de novo, mantém o que já estava salvo
      refreshToken: tokens.refresh_token || existente.refreshToken,
      accessToken: tokens.access_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      email: perfil.email || existente.email || '',
      conectadoEm: new Date().toISOString(),
    });
    return destino('conectado');
  } catch (e) {
    console.error('google-oauth callback:', e?.message || e);
    return destino('erro');
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  const url = new URL(req.url);
  if (req.method === 'GET') return tratarCallback(url);   // é o Google chamando de volta

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!CLIENT_SECRET) return json({ ok: false, error: 'Google ainda não configurado no servidor (fale com o suporte).' });

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  if (!auth.admin) return json({ ok: false, error: 'Somente a administradora conecta o Google Agenda.' });
  const contaId = auth.contaId;

  if (body.action === 'auth') {
    const client = criarOAuthClient();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',   // força reenvio do refresh_token mesmo numa reconexão
      scope: SCOPES,
      state: assinarState(contaId),
    });
    return json({ ok: true, url: authUrl });
  }

  return json({ error: 'unknown_action' }, 400);
};

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

export const config = { path: '/api/google-oauth' };
