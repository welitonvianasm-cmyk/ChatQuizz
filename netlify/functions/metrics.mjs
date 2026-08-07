/**
 * Leitura agregável dos leads pro dashboard administrativo.
 *
 * Por que existe: a tabela diag_instagram_leads tem RLS write-only (a anon
 * só insere/atualiza). Logo, NINGUÉM lê do front — a leitura passa por aqui,
 * com a service_role guardada como env de backend, e protegida por um token.
 *
 * Segurança:
 *   - Exige DASHBOARD_TOKEN no env. Sem ele, responde 503 (nunca abre os dados).
 *   - O cliente manda o token no header `x-dash-token` (ou no body.token).
 *     Comparação de tempo ~constante pra não vazar o tamanho por timing.
 *   - Só GET de colunas selecionadas (sem reel_transcript / bio / foto crua).
 *
 * Env:
 *   DASHBOARD_TOKEN       — senha de acesso ao painel (defina no Netlify).
 *   SUPABASE_DIAG_SERVICE — service_role do projeto dedicado.
 *   SUPABASE_DIAG_URL     — URL do projeto dedicado.
 */
import { temConfig, autenticar, registrarLog } from '../_tokens.mjs';
const SUPABASE_URL = (process.env.SUPABASE_DIAG_URL || 'https://aktktxizmpwckvxbdjzf.supabase.co').replace(/\/+$/, '');
const TABLE = 'diag_instagram_leads';

// colunas que o dashboard precisa (PII fica protegida pelo token; texto longo fica de fora)
const COLS = [
  'lead_ref', 'status', 'nome', 'email', 'whatsapp', 'uf',
  'instagram', 'nicho', 'nicho_detectado', 'seguidores', 'dificuldade',
  'renda', 'lead_score', 'qualificado', 'call_track', 'vendedor',
  'agendado', 'agendamento_em', 'booking_uid', 'atendente', 'agendamento_status', 'equipe_json',
  'resultado', 'resultado_motivo', 'resultado_em', 'resultado_por', 'etapa', 'venda_json',
  'ig_followers', 'ig_posts', 'ig_verificado', 'ig_categoria',
  'reel_views', 'reel_likes', 'reel_comments',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'referrer',
  'created_at', 'updated_at',
].join(',');

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!temConfig()) return json({ error: 'DASHBOARD_TOKEN not configured' }, 503);

  const KEY = process.env.SUPABASE_DIAG_SERVICE;
  if (!KEY) return json({ error: 'SUPABASE_DIAG_SERVICE not configured' }, 500);

  try {
    let body = {};
    try { body = await req.json(); } catch { /* sem body */ }
    const sent = req.headers.get('x-dash-token') || body.token || '';
    const auth = await autenticar(sent);
    if (!auth.ok) {
      return json({ error: auth.expirado ? 'expired' : 'unauthorized' }, auth.expirado ? 403 : 401);
    }

    // registro de extração de relatório (chamado pelo botão CSV do painel)
    if (body.log === 'exportou_relatorio') {
      await registrarLog('exportou_relatorio', auth.user);
      return json({ ok: true });
    }
    // registro de acesso ao painel (a sincronização automática passa
    // silencioso:true pra não inflar o livro de registros a cada minuto)
    if (!body.silencioso) await registrarLog('acesso', auth.user);

    // paginação: PostgREST devolve no máx. ~1000 linhas por página (Range)
    let colsAtivas = COLS;
    const PAGE = 1000;
    const MAX_PAGES = 50; // teto de segurança (50k leads)
    let rows = [];
    let total = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const to = from + PAGE - 1;
      const hdrs = {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Range: `${from}-${to}`,
        'Range-Unit': 'items',
        Prefer: 'count=exact',
      };
      const buscar = () => fetch(
        `${SUPABASE_URL}/rest/v1/${TABLE}?select=${colsAtivas}&order=created_at.desc`,
        { headers: hdrs }
      );
      let res = await buscar();
      // alguma coluna nova ainda não existe no banco? vai tirando até funcionar
      const RECUOS = [',venda_json', ',etapa', ',resultado,resultado_motivo,resultado_em,resultado_por', ',equipe_json', ',atendente,agendamento_status'];
      for (const recuo of RECUOS) {
        if (res.ok || res.status !== 400 || !colsAtivas.includes(recuo.slice(1).split(',')[0])) continue;
        colsAtivas = colsAtivas.replace(recuo, '');
        res = await buscar();
      }
      if (!res.ok) {
        const errText = await res.text();
        console.error('metrics read error:', res.status, errText.slice(0, 200));
        return json({ error: 'DB read failed' }, 500);
      }
      const batch = await res.json();
      rows = rows.concat(batch);
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)$/);
      if (m) total = Number(m[1]);
      if (batch.length < PAGE) break; // última página
    }

    // nomes dos atendentes (equipe) — pro seletor de responsável nas telas
    // + quem tem Função CS (recebe leads convertidos no Pós-Venda)
    let atendentes = [];
    let equipeCS = [];
    try {
      let ra = await fetch(`${SUPABASE_URL}/rest/v1/dash_users?select=nome,funcao_cs&order=nome.asc`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      });
      if (!ra.ok) ra = await fetch(`${SUPABASE_URL}/rest/v1/dash_users?select=nome&order=nome.asc`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      });
      if (ra.ok) {
        const us = await ra.json();
        atendentes = us.map((x) => x.nome).filter(Boolean);
        equipeCS = us.filter((x) => x.funcao_cs).map((x) => x.nome).filter(Boolean);
      }
    } catch { /* melhor-esforço */ }

    return json({ ok: true, admin: !!auth.admin, cs: !!auth.cs, trocar_senha: !!auth.trocarSenha, usuario: auth.user.nome || '', atendentes, equipeCS, total: total ?? rows.length, count: rows.length, leads: rows });
  } catch (err) {
    console.error('metrics error:', err);
    return json({ error: err.message }, 500);
  }
};

// comparação de tempo ~constante (evita vazar tamanho/prefixo por timing)
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-dash-token',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export const config = { path: '/api/metrics' };
