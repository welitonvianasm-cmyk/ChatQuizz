/**
 * LINKS DE RASTREIO — links curtos (/l/:slug) que redirecionam pro quiz já
 * com utm_source/utm_medium/utm_campaign preenchidos, pra saber de onde
 * cada lead veio (Instagram, Facebook, grupo de WhatsApp, etc).
 *
 * Guardados em funnel_config (chave 'links_rastreio', lista em JSON) — sem
 * tabela nova. O redirecionamento em si é servido por link-redirect.mjs
 * (rota pública /l/:slug), que lê a mesma chave.
 *
 *   { token, action:'listar' }                                          → { ok, links }
 *   { token, action:'criar',  nome, slug?, utm_source?, utm_medium?, utm_campaign? }  (admin)
 *   { token, action:'editar', slug, nome?, utm_source?, utm_medium?, utm_campaign?, ativo? }  (admin)
 *   { token, action:'excluir', slug }  (admin — soft delete: ativo=false, nunca some de vez)
 */
import { temConfig, autenticar } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE = 'links_rastreio';

function slugificar(v) {
  const semAcento = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return semAcento.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function carregarLista() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE}&select=value&limit=1`, { headers: H });
    if (r.ok) { const rows = await r.json(); const v = rows[0] && JSON.parse(rows[0].value || '[]'); if (Array.isArray(v)) return v; }
  } catch { /* lista vazia */ }
  return [];
}
async function salvarLista(lista) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: CHAVE, value: JSON.stringify(lista), updated_at: new Date().toISOString() }),
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticar(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  try {
    const a = body.action;

    if (a === 'listar') {
      return json({ ok: true, links: await carregarLista() });
    }

    if (!auth.admin) return json({ ok: false, error: 'Somente a administradora gerencia os links de rastreio.' });

    if (a === 'criar') {
      const nome = String(body.nome || '').trim().slice(0, 80);
      if (!nome) return json({ ok: false, error: 'Dê um nome ao link (ex: Instagram Bio).' });
      const lista = await carregarLista();
      let slug = slugificar(body.slug || nome);
      if (!slug) return json({ ok: false, error: 'Não consegui gerar um slug válido pra esse nome.' });
      let base = slug, i = 2;
      while (lista.some((l) => l.slug === slug)) { slug = `${base}-${i++}`; }
      lista.push({
        slug, nome,
        utm_source: String(body.utm_source || slug).trim().slice(0, 100),
        utm_medium: String(body.utm_medium || '').trim().slice(0, 100),
        utm_campaign: String(body.utm_campaign || '').trim().slice(0, 100),
        ativo: true, criado_em: new Date().toISOString(),
      });
      await salvarLista(lista);
      return json({ ok: true, slug });
    }

    if (a === 'editar') {
      const slug = String(body.slug || '').trim();
      const lista = await carregarLista();
      const item = lista.find((l) => l.slug === slug);
      if (!item) return json({ ok: false, error: 'Link não encontrado.' });
      if ('nome' in body) item.nome = String(body.nome || '').trim().slice(0, 80) || item.nome;
      if ('utm_source' in body) item.utm_source = String(body.utm_source || '').trim().slice(0, 100);
      if ('utm_medium' in body) item.utm_medium = String(body.utm_medium || '').trim().slice(0, 100);
      if ('utm_campaign' in body) item.utm_campaign = String(body.utm_campaign || '').trim().slice(0, 100);
      if ('ativo' in body) item.ativo = !!body.ativo;
      await salvarLista(lista);
      return json({ ok: true });
    }

    if (a === 'excluir') {
      const slug = String(body.slug || '').trim();
      const lista = await carregarLista();
      const item = lista.find((l) => l.slug === slug);
      if (!item) return json({ ok: false, error: 'Link não encontrado.' });
      item.ativo = false;   // soft delete — leads antigos continuam mostrando a origem certa
      await salvarLista(lista);
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('links:', e?.message || e);
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

export const config = { path: '/api/links' };
