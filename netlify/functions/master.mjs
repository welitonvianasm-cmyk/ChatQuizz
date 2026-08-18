/**
 * PAINEL MASTER — gestão de TODAS as contas (assinantes) do QuizzHub.
 * Vive dentro do dashboard.html (módulo "Master" na barra lateral) — usa o
 * MESMO login (e-mail+senha) de sempre. Só fica disponível pra quem tem
 * `eh_superadmin=true` em `usuarios` (coluna nunca exposta a admins de
 * conta comuns — só é ligada via SQL direto no banco).
 *
 *   { token, action:'listar' }
 *     → { ok, contas:[{ id, nome, subdominio, plano, status, criado_em,
 *          plano_definido_em, totalUsuarios, donoNome, donoEmail,
 *          tipo_pessoa, documento, telefone, cep, endereco, bairro, cidade, uf }] }
 *
 *   { token, action:'criar', nome, plano?, subdominio?, tipo_pessoa?, documento?,
 *     telefone?, cep?, endereco?, bairro?, cidade?, uf?, donoNome, donoEmail }
 *     → { ok, subdominio, senhaTemporaria }   (cria a conta + o usuário dono)
 *
 *   { token, action:'atualizar', id, plano?, status?, tipo_pessoa?, documento?,
 *     telefone?, cep?, endereco?, bairro?, cidade?, uf? }               → { ok }
 *
 *   { token, action:'excluir',   id }   → { ok }   (soft delete: status='excluida')
 *   { token, action:'restaurar', id }   → { ok }   (desfaz o excluir: status='ativa')
 *
 *   { token, action:'ativar_dominio',   id }   → { ok }
 *     Marca dominio_status='ativo'. Rode isso SÓ depois de conferir o DNS
 *     do domínio (deve apontar/CNAME pro site) e de adicioná-lo manualmente
 *     em Netlify → Domain management → Add domain alias (isso não é
 *     automático — evita mexer na configuração do site sem revisão).
 *   { token, action:'desativar_dominio', id } → { ok }  (volta pra 'pendente')
 *
 *   { token, action:'log_impersonar', contaId } → { ok }
 *     Registro de auditoria: chamado 1x pelo dashboard quando o master
 *     entra em "Acessar como" — não em toda requisição feita já impersonando.
 *
 * "E-mail do administrador" de cada conta NÃO é um campo próprio — é sempre o
 * e-mail de login de quem tem eh_dono=true em `usuarios` (fonte única da verdade,
 * evita duas cópias do mesmo dado podendo ficar dessincronizadas).
 */
import { randomBytes } from 'node:crypto';
import { hashSenha, autenticarToken, registrarLog } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const PLANOS_VALIDOS = new Set(['lite', 'completo']);
const STATUS_VALIDOS = new Set(['ativa', 'suspensa']);
const TIPOS_PESSOA_VALIDOS = new Set(['fisica', 'juridica']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* master = login normal (e-mail+senha) de um usuário com eh_superadmin=true */
async function autenticarMaster(token) {
  const auth = await autenticarToken(token);
  if (!auth.ok || !auth.superadmin) return null;
  return auth;
}

/* senha temporária legível, ex: quizzhub-K4TQ-7MX2 (mesmo padrão de dash-users.mjs) */
function gerarSenhaTemp() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bloco = (n) => Array.from(randomBytes(n)).map((b) => abc[b % abc.length]).join('');
  return `quizzhub-${bloco(4)}-${bloco(4)}`;
}

function slugificar(v) {
  const semAcento = String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return semAcento.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/* campos cadastrais compartilhados por 'criar' e 'atualizar' */
function lerCamposCadastrais(body) {
  const out = {};
  if ('tipo_pessoa' in body) {
    const tipo = String(body.tipo_pessoa || '').trim().toLowerCase();
    if (tipo && !TIPOS_PESSOA_VALIDOS.has(tipo)) return { erro: 'Tipo de pessoa inválido.' };
    out.tipo_pessoa = tipo || null;
  }
  if ('documento' in body) out.documento = String(body.documento || '').trim().slice(0, 30) || null;
  if ('telefone' in body) out.telefone = String(body.telefone || '').trim().slice(0, 30) || null;
  if ('cep' in body) out.cep = String(body.cep || '').trim().slice(0, 12) || null;
  if ('endereco' in body) out.endereco = String(body.endereco || '').trim().slice(0, 160) || null;
  if ('bairro' in body) out.bairro = String(body.bairro || '').trim().slice(0, 80) || null;
  if ('cidade' in body) out.cidade = String(body.cidade || '').trim().slice(0, 80) || null;
  if ('uf' in body) out.uf = String(body.uf || '').trim().slice(0, 2).toUpperCase() || null;
  return { out };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const token = req.headers.get('x-dash-token') || body.token || '';
  const auth = await autenticarMaster(token);
  if (!auth) return json({ error: 'unauthorized' }, 401);

  try {
    const a = body.action;

    if (a === 'log_impersonar') {
      const contaId = Number(body.contaId) || 0;
      if (contaId) await registrarLog('impersonou', auth.user, contaId);
      return json({ ok: true });
    }

    if (a === 'listar') {
      const rc = await fetch(
        `${SB_URL}/rest/v1/contas?select=id,nome,subdominio,plano,status,criado_em,plano_definido_em,tipo_pessoa,documento,telefone,cep,endereco,bairro,cidade,uf,dominio_proprio,dominio_status&order=criado_em.asc`,
        { headers: H }
      );
      if (!rc.ok) return json({ ok: false, error: 'Erro ao carregar as contas.' });
      const contas = await rc.json();

      // usuários de todas as contas numa query só (número pequeno de tenants, sem paginação)
      const ru = await fetch(`${SB_URL}/rest/v1/usuarios?select=conta_id,nome,email,eh_dono`, { headers: H });
      const totalPorConta = new Map();
      const donoPorConta = new Map();
      if (ru.ok) {
        for (const u of await ru.json()) {
          totalPorConta.set(u.conta_id, (totalPorConta.get(u.conta_id) || 0) + 1);
          if (u.eh_dono) donoPorConta.set(u.conta_id, u);
        }
      }
      contas.forEach((c) => {
        c.totalUsuarios = totalPorConta.get(c.id) || 0;
        const dono = donoPorConta.get(c.id);
        c.donoNome = dono ? dono.nome : '';
        c.donoEmail = dono ? dono.email : '';
      });

      return json({ ok: true, contas });
    }

    if (a === 'criar') {
      const nome = String(body.nome || '').trim().slice(0, 120);
      const donoNome = String(body.donoNome || '').trim().slice(0, 120);
      const donoEmail = String(body.donoEmail || '').trim().toLowerCase().slice(0, 200);
      const plano = String(body.plano || 'lite').trim().toLowerCase();
      if (!nome) return json({ ok: false, error: 'Informe o nome da conta.' });
      if (!donoNome) return json({ ok: false, error: 'Informe o nome do responsável.' });
      if (!EMAIL_RE.test(donoEmail)) return json({ ok: false, error: 'E-mail do responsável inválido.' });
      if (!PLANOS_VALIDOS.has(plano)) return json({ ok: false, error: 'Plano inválido.' });
      const cad = lerCamposCadastrais(body);
      if (cad.erro) return json({ ok: false, error: cad.erro });

      const rDup = await fetch(`${SB_URL}/rest/v1/usuarios?email=eq.${encodeURIComponent(donoEmail)}&select=id&limit=1`, { headers: H });
      if (rDup.ok && (await rDup.json()).length) {
        return json({ ok: false, error: 'Já existe uma conta cadastrada com esse e-mail.' });
      }

      let slug = slugificar(body.subdominio || nome) || 'conta';
      const rSlugs = await fetch(`${SB_URL}/rest/v1/contas?subdominio=like.${encodeURIComponent(slug)}*&select=subdominio`, { headers: H });
      const existentes = new Set(rSlugs.ok ? (await rSlugs.json()).map((c) => c.subdominio) : []);
      let subdominio = slug, i = 2;
      while (existentes.has(subdominio)) { subdominio = `${slug}-${i++}`; }

      const agora = new Date().toISOString();
      const rConta = await fetch(`${SB_URL}/rest/v1/contas`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ nome, subdominio, plano, status: 'ativa', plano_definido_em: agora, ...cad.out }),
      });
      if (!rConta.ok) { console.error('master criar conta:', rConta.status, await rConta.text().catch(() => '')); return json({ ok: false, error: 'Erro ao criar a conta.' }, 500); }
      const conta = (await rConta.json())[0];

      const senhaTemporaria = gerarSenhaTemp();
      const rUsuario = await fetch(`${SB_URL}/rest/v1/usuarios`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          conta_id: conta.id, nome: donoNome, email: donoEmail, celular: '',
          senha_hash: hashSenha(senhaTemporaria), trocar_senha: true, funcao_adm: true, eh_dono: true,
        }),
      });
      if (!rUsuario.ok) {
        await fetch(`${SB_URL}/rest/v1/contas?id=eq.${conta.id}`, { method: 'DELETE', headers: H }).catch(() => {});
        console.error('master criar usuario:', rUsuario.status, await rUsuario.text().catch(() => ''));
        return json({ ok: false, error: 'Erro ao criar o usuário responsável.' }, 500);
      }

      return json({ ok: true, subdominio, senhaTemporaria });
    }

    if (a === 'atualizar') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'Conta inválida.' });
      const patch = { atualizado_em: new Date().toISOString() };
      if ('plano' in body) {
        const plano = String(body.plano || '').trim().toLowerCase();
        if (!PLANOS_VALIDOS.has(plano)) return json({ ok: false, error: 'Plano inválido.' });
        patch.plano = plano;
        patch.plano_definido_em = new Date().toISOString();
      }
      if ('status' in body) {
        const status = String(body.status || '').trim().toLowerCase();
        if (!STATUS_VALIDOS.has(status)) return json({ ok: false, error: 'Status inválido.' });
        patch.status = status;
      }
      const cad = lerCamposCadastrais(body);
      if (cad.erro) return json({ ok: false, error: cad.erro });
      Object.assign(patch, cad.out);

      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar.' });
      return json({ ok: true });
    }

    if (a === 'excluir' || a === 'restaurar') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'Conta inválida.' });
      const status = a === 'excluir' ? 'excluida' : 'ativa';
      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, atualizado_em: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar.' });
      return json({ ok: true });
    }

    if (a === 'ativar_dominio' || a === 'desativar_dominio') {
      const id = Number(body.id) || 0;
      if (!id) return json({ ok: false, error: 'Conta inválida.' });
      const dominio_status = a === 'ativar_dominio' ? 'ativo' : 'pendente';
      const r = await fetch(`${SB_URL}/rest/v1/contas?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ dominio_status, atualizado_em: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao salvar.' });
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('master:', e?.message || e);
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

export const config = { path: '/api/master' };
