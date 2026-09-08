/**
 * APARÊNCIA / IDENTIDADE DO QUIZ — número de WhatsApp, avatar, logo,
 * presente (com opção de não ter), site e cor primária. Tudo editável
 * pelo painel, sem precisar mexer em código. Multi-tenant: cada conta
 * tem a própria (funnel_config escopado por conta_id).
 *
 *   GET  /api/aparencia                 → { ok, ...aparencia, personalizado }
 *        (quiz público resolve a conta pelo subdomínio; painel autenticado
 *        manda x-dash-token e resolve pelo login — os dois usam o mesmo GET)
 *   POST /api/aparencia { token, ... }  → salva (SÓ administradora)
 *   POST /api/aparencia { token, action:'restaurar' } → volta ao padrão
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { resolverContaPorHost } from '../_tenant.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE = 'aparencia';

const PADRAO = {
  titulo: 'Seu Diagnóstico',
  logo_cabecalho_url: '',
  whatsapp_numero: '',
  avatar_url: '',
  avatar_fallback: '',
  site_url: '',
  cor_primaria: '#005355',
  cor_cabecalho: '#ffffff',
  cor_titulo: '#14201e',
  cor_contador: '#005355',
  cor_balao_bot: '#eef4f2',
  cor_texto_balao_bot: '#14201e',
  mensagem_boas_vindas: 'Oi! Eu estou aqui pra te ajudar a entender melhor o seu momento. Responda com sinceridade! 💚',
  tem_presente: false,
  presente_imagem: '',
  presente_nome: '',
  presente_descricao: '',
  cta_url_texto: 'Continuar',
  cta_url_cor: '#a155f2',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function sanitizar(body) {
  const txt = (v, max) => String(v ?? '').trim().slice(0, max);
  const corOpc = (v, campo, padrao) => {
    const c = txt(v, 7);
    if (c && !HEX.test(c)) return { erro: `${campo} precisa ser um hexadecimal válido, ex: ${padrao}.` };
    return { valor: c || padrao };
  };
  const cCorPrimaria = corOpc(body.cor_primaria, 'Cor primária', PADRAO.cor_primaria);
  if (cCorPrimaria.erro) return cCorPrimaria;
  const cCtaCor = corOpc(body.cta_url_cor, 'Cor do botão', PADRAO.cta_url_cor);
  if (cCtaCor.erro) return cCtaCor;
  const cCorCabecalho = corOpc(body.cor_cabecalho, 'Cor do cabeçalho', PADRAO.cor_cabecalho);
  if (cCorCabecalho.erro) return cCorCabecalho;
  const cCorTitulo = corOpc(body.cor_titulo, 'Cor do título', PADRAO.cor_titulo);
  if (cCorTitulo.erro) return cCorTitulo;
  const cCorContador = corOpc(body.cor_contador, 'Cor do contador de perguntas', PADRAO.cor_contador);
  if (cCorContador.erro) return cCorContador;
  const cCorBalaoBot = corOpc(body.cor_balao_bot, 'Cor do balão de pergunta', PADRAO.cor_balao_bot);
  if (cCorBalaoBot.erro) return cCorBalaoBot;
  const cCorTextoBalaoBot = corOpc(body.cor_texto_balao_bot, 'Cor do texto do balão de pergunta', PADRAO.cor_texto_balao_bot);
  if (cCorTextoBalaoBot.erro) return cCorTextoBalaoBot;
  const numero = txt(body.whatsapp_numero, 20).replace(/\D/g, '');
  if (numero && numero.length < 10) return { erro: 'Número de WhatsApp inválido (use DDI+DDD+número, só dígitos).' };
  return {
    limpo: {
      titulo: txt(body.titulo, 60) || PADRAO.titulo,
      logo_cabecalho_url: txt(body.logo_cabecalho_url, 500),
      whatsapp_numero: numero,
      avatar_url: txt(body.avatar_url, 500),
      avatar_fallback: txt(body.avatar_fallback, 500),
      site_url: txt(body.site_url, 500),
      cor_primaria: cCorPrimaria.valor,
      cor_cabecalho: cCorCabecalho.valor,
      cor_titulo: cCorTitulo.valor,
      cor_contador: cCorContador.valor,
      cor_balao_bot: cCorBalaoBot.valor,
      cor_texto_balao_bot: cCorTextoBalaoBot.valor,
      mensagem_boas_vindas: txt(body.mensagem_boas_vindas, 600),
      tem_presente: !!body.tem_presente,
      presente_imagem: txt(body.presente_imagem, 500),
      presente_nome: txt(body.presente_nome, 80),
      presente_descricao: txt(body.presente_descricao, 200),
      cta_url_texto: txt(body.cta_url_texto, 40) || PADRAO.cta_url_texto,
      cta_url_cor: cCtaCor.valor,
    },
  };
}

async function resolverContaGet(req) {
  const token = req.headers.get('x-dash-token') || '';
  if (token) {
    const auth = await autenticarToken(token);
    if (auth.ok) return auth.contaId;
  }
  return resolverContaPorHost(req);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });

  if (req.method === 'GET') {
    const contaId = await resolverContaGet(req);
    if (!contaId) return json({ error: 'Conta não encontrada' }, 404);
    let salva = null;
    try {
      const r = await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE}&select=value&limit=1`, { headers: H });
      if (r.ok) { const rows = await r.json(); if (rows[0] && rows[0].value) salva = JSON.parse(rows[0].value); }
    } catch { /* usa padrão */ }
    if (salva) return json({ ok: true, ...PADRAO, ...salva, personalizado: true });
    return json({ ok: true, ...PADRAO, personalizado: false });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok || !auth.admin) return json({ error: 'admin_only' }, 401);
  const contaId = auth.contaId;

  try {
    if (body.action === 'restaurar') {
      await fetch(`${SB_URL}/rest/v1/funnel_config?conta_id=eq.${contaId}&key=eq.${CHAVE}`, { method: 'DELETE', headers: H });
      return json({ ok: true, ...PADRAO });
    }
    const v = sanitizar(body);
    if (v.erro) return json({ ok: false, error: v.erro });
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=conta_id,key`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ conta_id: contaId, key: CHAVE, value: JSON.stringify(v.limpo), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json({ ok: false, error: 'Erro ao salvar no banco.' });
    return json({ ok: true, ...v.limpo });
  } catch (e) {
    console.error('aparencia:', e?.message || e);
    return json({ error: 'error' }, 500);
  }
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

export const config = { path: '/api/aparencia' };
