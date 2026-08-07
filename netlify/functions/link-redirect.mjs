/**
 * REDIRECIONAMENTO DOS LINKS DE RASTREIO — rota pública /l/:slug.
 *
 * Resolve o slug na lista configurada (funnel_config, chave
 * 'links_rastreio' — gerenciada por links.mjs) e redireciona (302) pro
 * quiz já com utm_source/utm_medium/utm_campaign preenchidos.
 *
 * Slug inválido/desativado/erro de rede → redireciona pro quiz sem
 * parâmetros. Nunca mostra erro pro lead; na pior hipótese ele cai na
 * página normal do quiz, sem origem rastreada.
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const CHAVE = 'links_rastreio';

export default async (req) => {
  const url = new URL(req.url);
  const slug = decodeURIComponent(url.pathname.replace(/^\/l\//, '').replace(/\/+$/, ''));

  let destino = '/';
  try {
    if (slug && SB_URL && SB_KEY) {
      const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE}&select=value&limit=1`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      if (r.ok) {
        const rows = await r.json();
        const lista = rows[0] ? JSON.parse(rows[0].value || '[]') : [];
        const link = Array.isArray(lista) ? lista.find((l) => l && l.slug === slug && l.ativo !== false) : null;
        if (link) {
          const p = new URLSearchParams();
          if (link.utm_source) p.set('utm_source', link.utm_source);
          if (link.utm_medium) p.set('utm_medium', link.utm_medium);
          if (link.utm_campaign) p.set('utm_campaign', link.utm_campaign);
          const qs = p.toString();
          destino = qs ? `/?${qs}` : '/';
        }
      }
    }
  } catch (e) {
    console.warn('link-redirect: falhou, caindo pro quiz sem origem:', e?.message || e);
  }

  return new Response(null, { status: 302, headers: { Location: destino } });
};

export const config = { path: '/l/:slug' };
