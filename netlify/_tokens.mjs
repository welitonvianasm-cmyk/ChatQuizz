/* ====================================================================
   Autenticação do painel — multi-tenant (QuizzHub).
   - `usuarios` (Supabase, ex-`dash_users`): cada linha pertence a uma
     `conta` (conta_id). Login por E-MAIL + SENHA (a senha nunca é
     comparada em texto puro — fica guardada como hash+salt PRÓPRIO de
     cada usuário via scrypt nativo do Node, sem dependência nova).
   - `eh_dono`: quem se cadastrou/é responsável pela conta (só ele ou
     quem tem funcao_adm pode trocar plano/gerenciar a equipe).
   - `trocar_senha = true` força o usuário a definir a própria senha
     no primeiro acesso (senha temporária gerada pelo sistema).
   - dash_logs: registra acessos, extrações de relatório e trocas de senha.

   IMPORTANTE: `DASHBOARD_TOKEN` (senha única de administradora) deixou
   de existir como conceito — cada conta tem seu(s) próprio(s)
   usuário(s) admin (funcao_adm/eh_dono). `temConfig()` agora verifica
   se o Supabase está configurado, não uma senha de deploy.
   ==================================================================== */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

/* hash com salt PRÓPRIO por senha — formato armazenado: "salt:hash" (hex) */
export function hashSenha(senhaPlana) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(senhaPlana || ''), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarSenha(senhaPlana, senhaHashSalva) {
  const partes = String(senhaHashSalva || '').split(':');
  if (partes.length !== 2) return false; // formato antigo/inválido — força reset
  const [salt, hashSalvo] = partes;
  try {
    const hashTentativa = scryptSync(String(senhaPlana || ''), salt, 64).toString('hex');
    const a = Buffer.from(hashTentativa, 'hex');
    const b = Buffer.from(hashSalvo, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* o painel só liga se o Supabase estiver configurado */
export function temConfig() {
  return !!(SB_URL && SB_KEY);
}

/* busca os dados de uma conta (plano/status/domínio) — reaproveitado tanto
   pro login normal quanto pra impersonação (autenticarToken, abaixo) */
async function carregarConta(contaId) {
  const rc = await fetch(
    `${SB_URL}/rest/v1/contas?id=eq.${contaId}&select=id,nome,plano,status,plano_definido_em,dominio_proprio,dominio_status&limit=1`,
    { headers: SB_HEADERS }
  );
  if (!rc.ok) {
    const bodyTxt = await rc.text().catch(() => '');
    console.error('carregarConta: falhou', contaId, rc.status, bodyTxt);
    return { _debugStatus: rc.status, _debugBody: bodyTxt };
  }
  const rows = await rc.json();
  return rows[0] || null;
}

/* valida e-mail+senha → { ok, admin, cs, superadmin, expirado?, trocarSenha?, contaId, contaPlano, contaStatus, user:{id,nome,email,celular,validade,ehDono} } */
export async function autenticar(email, senhaPlana) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const senha = String(senhaPlana || '');
  if (!emailNorm || !senha) return { ok: false };
  if (!SB_URL || !SB_KEY) return { ok: false };

  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/usuarios?email=eq.${encodeURIComponent(emailNorm)}&select=id,nome,email,celular,validade,senha_hash,trocar_senha,funcao_adm,funcao_cs,eh_dono,eh_superadmin,conta_id&limit=1`,
      { headers: SB_HEADERS }
    );
    if (!r.ok) return { ok: false, reason: 'select_usuarios_falhou:' + r.status + ':' + (await r.text().catch(() => '')) };
    const rows = await r.json();
    const u = Array.isArray(rows) ? rows[0] : null;
    if (!u) return { ok: false, reason: 'usuario_nao_encontrado' };
    if (!verificarSenha(senha, u.senha_hash)) return { ok: false, reason: 'senha_nao_bateu' };
    if (u.validade && new Date(u.validade + 'T23:59:59-03:00') < new Date()) {
      return { ok: false, expirado: true, reason: 'validade_vencida' };
    }

    // conta precisa estar ativa
    const conta = await carregarConta(u.conta_id);
    if (conta && conta._debugStatus) return { ok: false, reason: 'conta_select_falhou:' + conta._debugStatus + ':' + conta._debugBody };
    if (!conta) return { ok: false, reason: 'conta_nao_encontrada:' + u.conta_id };
    if (conta.status !== 'ativa') return { ok: false, contaSuspensa: true, reason: 'conta_status:' + conta.status };

    return {
      ok: true,
      admin: !!u.funcao_adm || !!u.eh_dono,
      cs: !!u.funcao_cs,
      superadmin: !!u.eh_superadmin,
      trocarSenha: !!u.trocar_senha,
      contaId: u.conta_id,
      contaPlano: conta.plano,
      contaStatus: conta.status,
      contaPlanoDefinido: !!conta.plano_definido_em,
      contaDominio: conta.dominio_proprio || '',
      contaDominioStatus: conta.dominio_status || '',
      user: { ...u, ehDono: !!u.eh_dono },
    };
  } catch (e) {
    return { ok: false, reason: 'excecao:' + (e?.message || e) };
  }
}

/* Resolve a sessão a partir de um token simples "email::senha" (mesmo
   princípio já usado no painel: reautentica a cada chamada, sem estado
   de sessão no servidor). Usado por TODAS as functions autenticadas —
   nunca aceitar conta_id vindo do corpo da requisição do cliente.

   Suporta um sufixo opcional de IMPERSONAÇÃO: "email::senha::impersonar:<contaId>"
   — só tem efeito se quem autentica (email+senha) for superadmin de verdade;
   pra qualquer outro usuário o sufixo é silenciosamente ignorado (nunca vira
   um jeito de acessar a conta de outra pessoa). */
const MARCADOR_IMPERSONAR = '::impersonar:';
export async function autenticarToken(token) {
  const s = String(token || '');
  let base = s;
  let impersonarContaId = null;
  const idxImp = s.indexOf(MARCADOR_IMPERSONAR);
  if (idxImp >= 0) {
    base = s.slice(0, idxImp);
    impersonarContaId = Number(s.slice(idxImp + MARCADOR_IMPERSONAR.length)) || null;
  }

  const i = base.indexOf('::');
  if (i < 0) return { ok: false };
  const auth = await autenticar(base.slice(0, i), base.slice(i + 2));
  if (!auth.ok || !impersonarContaId || !auth.superadmin) return auth;

  const contaAlvo = await carregarConta(impersonarContaId);
  if (!contaAlvo) return auth; // conta-alvo não existe mais — segue como login normal

  return {
    ...auth,
    admin: true, // acesso master: edição completa na conta impersonada
    contaId: contaAlvo.id,
    contaNome: contaAlvo.nome,
    contaPlano: contaAlvo.plano,
    contaStatus: contaAlvo.status,
    contaPlanoDefinido: !!contaAlvo.plano_definido_em,
    contaDominio: contaAlvo.dominio_proprio || '',
    contaDominioStatus: contaAlvo.dominio_status || '',
    impersonando: true,
    contaOriginalId: auth.contaId,
  };
}

/* grava no livro de registros (nunca derruba a requisição se falhar) */
export async function registrarLog(tipo, user, contaId) {
  if (!SB_URL || !SB_KEY || !user) return;
  try {
    await fetch(`${SB_URL}/rest/v1/dash_logs`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        tipo,
        nome: user.nome || '',
        email: user.email || '',
        celular: user.celular || '',
        validade: user.validade || null,
        conta_id: contaId,
      }),
    });
  } catch { /* log é melhor-esforço */ }
}
