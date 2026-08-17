/**
 * CADASTRO SELF-SERVICE — cria uma conta nova (tenant) + o usuário
 * dono dela. Rota pública (não existe login ainda nesse momento).
 *
 *   POST /api/signup { nomeConta, nomeResponsavel, email, senha }
 *     → { ok, token }   (token = "email::senha", já pronto pra logar)
 *
 * A conta nasce no plano 'lite' (padrão do banco) — a escolha explícita
 * de plano (Lite/Completo) acontece depois, no primeiro acesso ao
 * painel (tela própria, ver dashboard.html #gate3).
 */
import { hashSenha } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugificar(v) {
  const semAcento = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return semAcento.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SB_URL || !SB_KEY) return json({ ok: false, error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }

  const nomeConta = String(body.nomeConta || '').trim().slice(0, 120);
  const nomeResponsavel = String(body.nomeResponsavel || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const senha = String(body.senha || '');

  if (!nomeConta) return json({ ok: false, error: 'Informe o nome do seu negócio.' });
  if (!nomeResponsavel) return json({ ok: false, error: 'Informe seu nome.' });
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'E-mail inválido.' });
  if (senha.length < 6) return json({ ok: false, error: 'A senha precisa de pelo menos 6 caracteres.' });

  try {
    // e-mail é o identificador de login — precisa ser único em todo o sistema
    const rDup = await fetch(`${SB_URL}/rest/v1/usuarios?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, { headers: H });
    if (rDup.ok && (await rDup.json()).length) {
      return json({ ok: false, error: 'Já existe uma conta cadastrada com esse e-mail.' });
    }

    // subdomínio único (pro quiz público de cada conta) — deriva do nome, com sufixo se colidir
    let slug = slugificar(nomeConta) || 'conta';
    const rSlugs = await fetch(`${SB_URL}/rest/v1/contas?subdominio=like.${encodeURIComponent(slug)}*&select=subdominio`, { headers: H });
    const existentes = new Set(rSlugs.ok ? (await rSlugs.json()).map((c) => c.subdominio) : []);
    let subdominio = slug, i = 2;
    while (existentes.has(subdominio)) { subdominio = `${slug}-${i++}`; }

    const rConta = await fetch(`${SB_URL}/rest/v1/contas`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ nome: nomeConta, subdominio, email_contato: email, status: 'ativa' }),
    });
    if (!rConta.ok) {
      console.error('signup: erro ao criar conta', rConta.status, await rConta.text().catch(() => ''));
      return json({ ok: false, error: 'Erro ao criar a conta.' }, 500);
    }
    const conta = (await rConta.json())[0];

    const rUsuario = await fetch(`${SB_URL}/rest/v1/usuarios`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({
        conta_id: conta.id, nome: nomeResponsavel, email, celular: '',
        senha_hash: hashSenha(senha), trocar_senha: false, funcao_adm: true, eh_dono: true,
      }),
    });
    if (!rUsuario.ok) {
      // desfaz a conta órfã se o usuário não pôde ser criado
      await fetch(`${SB_URL}/rest/v1/contas?id=eq.${conta.id}`, { method: 'DELETE', headers: H }).catch(() => {});
      console.error('signup: erro ao criar usuário', rUsuario.status, await rUsuario.text().catch(() => ''));
      return json({ ok: false, error: 'Erro ao criar seu usuário.' }, 500);
    }

    return json({ ok: true, token: `${email}::${senha}`, subdominio });
  } catch (e) {
    console.error('signup:', e?.message || e);
    return json({ ok: false, error: 'error' }, 500);
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
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/signup' };
