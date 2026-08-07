/* ====================================================================
   Autenticação do painel administrativo — ADMIN + EQUIPE + LOG.
   - DASHBOARD_TOKEN (env): senha da ADMINISTRADORA (Suely).
   - dash_users (Supabase): usuários da equipe. A senha fica guardada
     como HASH (criptografada) — nem a administradora consegue ler.
     `trocar_senha = true` força o usuário a definir a própria senha
     no primeiro acesso (senha temporária gerada pelo sistema).
   - dash_logs: registra acessos, extrações de relatório e trocas de senha.
   ==================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export function hashSenha(s) {
  return createHash('sha256').update('suavis::' + String(s || '')).digest('hex');
}

/* o painel só liga se a senha da administradora existir no ambiente */
export function temConfig() {
  return !!String(process.env.DASHBOARD_TOKEN || '').trim();
}

/* valida a senha → { ok, admin, expirado?, trocarSenha?, user:{id,nome,email,celular,validade} } */
export async function autenticar(sent) {
  const s = String(sent || '').trim();
  if (!s) return { ok: false };

  // 1) administradora (senha do Netlify)
  const admin = String(process.env.DASHBOARD_TOKEN || '').trim();
  if (admin && safeEqual(s, admin)) {
    return { ok: true, admin: true, user: { nome: 'Administradora', email: '', celular: '', validade: null } };
  }

  // 2) usuários da equipe (busca pelo hash da senha)
  if (!SB_URL || !SB_KEY) return { ok: false };
  try {
    const h = hashSenha(s);
    // funcao_adm/funcao_cs podem não existir ainda (setup-posvenda.sql) — cai sem elas
    let r = await fetch(
      `${SB_URL}/rest/v1/dash_users?senha_hash=eq.${encodeURIComponent(h)}&select=id,nome,email,celular,validade,trocar_senha,funcao_adm,funcao_cs&limit=1`,
      { headers: SB_HEADERS }
    );
    if (!r.ok) {
      r = await fetch(
        `${SB_URL}/rest/v1/dash_users?senha_hash=eq.${encodeURIComponent(h)}&select=id,nome,email,celular,validade,trocar_senha&limit=1`,
        { headers: SB_HEADERS }
      );
    }
    if (!r.ok) return { ok: false };
    const rows = await r.json();
    const u = Array.isArray(rows) ? rows[0] : null;
    if (!u) return { ok: false };
    if (u.validade && new Date(u.validade + 'T23:59:59-03:00') < new Date()) {
      return { ok: false, expirado: true };
    }
    // Funções de ADM = mesmos privilégios da administradora (item 5 do pós-venda)
    return { ok: true, admin: !!u.funcao_adm, cs: !!u.funcao_cs, trocarSenha: !!u.trocar_senha, user: u };
  } catch {
    return { ok: false };
  }
}

/* grava no livro de registros (nunca derruba a requisição se falhar) */
export async function registrarLog(tipo, user) {
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
      }),
    });
  } catch { /* log é melhor-esforço */ }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
