/**
 * Captura progressiva na tabela PRÓPRIA do funil: diag_instagram_leads
 * (criada pelo setup.sql — nenhuma tabela existente do banco é tocada).
 *
 * UPSERT atômico por lead_ref (on_conflict): cada etapa do funil reenvia
 * o estado completo e a linha evolui.
 *
 * Usa a chave service_role — só como env no backend, nunca no front.
 * Não dá pra fazer isso com a anon + RLS write-only: no Postgres, tanto
 * UPDATE com WHERE quanto ON CONFLICT DO UPDATE passam pelas policies de
 * SELECT pra enxergar a linha-alvo; sem leitura, todo update pega 0 linhas.
 * O projeto Supabase é dedicado a este funil (só esta tabela), então o
 * raio de alcance da chave fica contido nele.
 *
 * Env:
 *   SUPABASE_DIAG_SERVICE — chave service_role do projeto dedicado.
 *   SUPABASE_DIAG_KEY — fallback (anon): 1º save entra, updates falham
 *     alto no log — melhor que perder o lead inteiro em silêncio.
 *   SUPABASE_DIAG_URL — URL do projeto dedicado.
 */
const SUPABASE_URL = (process.env.SUPABASE_DIAG_URL || 'https://aktktxizmpwckvxbdjzf.supabase.co').replace(/\/+$/, '');
const TABLE = 'diag_instagram_leads';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const KEY = process.env.SUPABASE_DIAG_SERVICE || process.env.SUPABASE_DIAG_KEY;
    if (!KEY) return json({ error: 'SUPABASE_DIAG_SERVICE not configured' }, 500);

    const b = await req.json();
    if (!b.lead_ref || !b.nome) return json({ error: 'Missing lead_ref/nome' }, 400);

    const digits = String(b.whatsapp || '').replace(/\D/g, '');
    // o front já manda ddi+número (E.164 sem '+'); só prefixa '+' — não força 55 (quebraria estrangeiro)
    const e164 = digits ? `+${digits}` : '';
    const p = (b.profile && typeof b.profile === 'object') ? b.profile : null;
    const r = (b.reel && typeof b.reel === 'object') ? b.reel : null;
    const txt = (v, max = 300) => String(v ?? '').slice(0, max);
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

    const row = {
      lead_ref: txt(b.lead_ref, 60),
      status: txt(b.status || 'parcial', 20),
      nome: txt(b.nome, 120),
      email: txt(b.email, 200).toLowerCase(),
      whatsapp: e164,
      uf: txt(b.uf, 4),
      instagram: txt(b.instagram, 40).replace(/^@/, '').toLowerCase(),
      nicho: txt(b.nicho, 60),
      nicho_detectado: txt(b.nicho_detectado, 60),
      seguidores: txt(b.seguidores, 40),
      dificuldade: txt(b.dificuldade, 300),
      renda: txt(b.faturamento, 60),
      lead_score: num(b.score),
      qualificado: typeof b.qualificado === 'boolean' ? b.qualificado : null,
      call_track: txt(b.call_track, 12),
      vendedor: txt(b.vendedor, 60),
      agendado: b.agendado === true,
      agendamento_em: b.agendamento_em || null,
      booking_uid: txt(b.booking_uid, 80),
      video_url: txt(b.video_url, 300),
      ...(p ? {
        ig_full_name: txt(p.fullName, 120),
        ig_bio: txt(p.biography, 400),
        ig_pic_url: txt(p.profilePicUrl, 500),
        ig_followers: num(p.followersCount),
        ig_following: num(p.followsCount),
        ig_posts: num(p.postsCount),
        ig_business: !!p.isBusinessAccount,
        ig_categoria: txt(p.businessCategoryName, 80),
        ig_link_bio: txt(p.externalUrl, 300),
        ig_verificado: !!p.verified,
      } : {}),
      ...(r ? {
        reel_url: txt(r.url, 300),
        reel_caption: txt(r.caption, 220),
        reel_views: num(r.views),
        reel_likes: num(r.likes),
        reel_comments: num(r.comments),
      } : {}),
      ...(b.reel_transcript ? { reel_transcript: txt(b.reel_transcript, 600) } : {}),
      utm_source: txt(b.utm_source, 200),
      utm_medium: txt(b.utm_medium, 200),
      utm_campaign: txt(b.utm_campaign, 200),
      utm_content: txt(b.utm_content, 200),
      utm_term: txt(b.utm_term, 200),
      fbclid: txt(b.fbclid, 255),
      referrer: txt(b.referrer, 300),
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=lead_ref`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Supabase save error:', res.status, errText.slice(0, 300));
      return json({ error: 'DB save failed' }, 500);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('save-lead error:', err);
    return json({ error: err.message }, 500);
  }
};

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

export const config = { path: '/api/save-lead' };
