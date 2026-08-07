/**
 * ÁREA EQUIPE — gestão de usuários do painel + livro de registros.
 *
 * Ações da ADMINISTRADORA (senha DASHBOARD_TOKEN):
 *   { token, action:'list' }                                   → { ok, users }  (sem senhas!)
 *   { token, action:'logs' }                                   → { ok, logs }
 *   { token, action:'create', nome, email, celular, validade } → { ok, senhaTemporaria }
 *   { token, action:'update', id, nome, email, celular, validade }
 *   { token, action:'reset',  id }                             → { ok, senhaTemporaria }
 *   { token, action:'delete', id }
 *
 * Ação do PRÓPRIO USUÁRIO (com a senha temporária ou atual):
 *   { token, action:'trocar_senha', novaSenha }                → { ok }
 */
import { randomBytes } from 'node:crypto';
import { temConfig, autenticar, registrarLog, hashSenha } from '../_tokens.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

/* senha temporária legível, ex: suavis-K4TQ-7MX2 */
function gerarSenhaTemp() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bloco = (n) => Array.from(randomBytes(n)).map((b) => abc[b % abc.length]).join('');
  return `suavis-${bloco(4)}-${bloco(4)}`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);
  if (!SB_URL || !SB_KEY) return json({ error: 'Supabase not configured' }, 500);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const token = req.headers.get('x-dash-token') || body.token || '';
  const auth = await autenticar(token);
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);

  try {
    const a = body.action;

    /* ---------- PRÓPRIO USUÁRIO: definir/trocar a senha ---------- */
    if (a === 'trocar_senha') {
      if (auth.admin) return json({ ok: false, error: 'A senha da administradora é trocada no painel da Netlify.' });
      const nova = String(body.novaSenha || '').trim();
      if (nova.length < 6) return json({ ok: false, error: 'A nova senha precisa de pelo menos 6 caracteres.' });
      const r = await fetch(`${SB_URL}/rest/v1/dash_users?id=eq.${auth.user.id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ senha_hash: hashSenha(nova), trocar_senha: false, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        const dup = /duplicate|unique/i.test(t);
        return json({ ok: false, error: dup ? 'Essa senha não pode ser usada. Escolha outra.' : 'Erro ao salvar a senha.' });
      }
      await registrarLog('definiu_senha', auth.user);
      return json({ ok: true });
    }

    /* ---------- daqui pra baixo: SÓ a administradora ---------- */
    if (!auth.admin) return json({ error: 'admin_only' }, 401);

    if (a === 'list') {
      let r = await fetch(`${SB_URL}/rest/v1/dash_users?select=id,nome,email,celular,validade,trocar_senha,criado_em,funcao_cs,funcao_adm&order=criado_em.asc`, { headers: H });
      if (!r.ok) r = await fetch(`${SB_URL}/rest/v1/dash_users?select=id,nome,email,celular,validade,trocar_senha,criado_em&order=criado_em.asc`, { headers: H });
      if (!r.ok) return json({ ok: false, error: 'As tabelas da equipe ainda não existem no Supabase. Rode o setup-equipe.sql (SQL Editor) e recarregue.' });
      return json({ ok: true, users: await r.json() });
    }

    if (a === 'logs') {
      const r = await fetch(`${SB_URL}/rest/v1/dash_logs?select=tipo,nome,email,celular,validade,criado_em&order=criado_em.desc&limit=300`, { headers: H });
      if (!r.ok) return json({ ok: true, logs: [] });
      return json({ ok: true, logs: await r.json() });
    }

    if (a === 'create' || a === 'update') {
      const u = {
        nome: String(body.nome || '').trim().slice(0, 120),
        email: String(body.email || '').trim().toLowerCase().slice(0, 200),
        celular: String(body.celular || '').trim().slice(0, 30),
        validade: body.validade || null,
        updated_at: new Date().toISOString(),
      };
      // funções extras (setup-posvenda.sql): CS recebe convertidos; ADM = privilégios totais
      if ('funcao_cs' in body) u.funcao_cs = !!body.funcao_cs;
      if ('funcao_adm' in body) u.funcao_adm = !!body.funcao_adm;
      if (!u.nome || !u.email) return json({ ok: false, error: 'Nome e e-mail são obrigatórios.' });

      let senhaTemporaria = null;
      if (a === 'create') {
        senhaTemporaria = gerarSenhaTemp();
        u.senha_hash = hashSenha(senhaTemporaria);
        u.trocar_senha = true;
      }
      const url = a === 'create'
        ? `${SB_URL}/rest/v1/dash_users`
        : `${SB_URL}/rest/v1/dash_users?id=eq.${Number(body.id) || 0}`;
      const r = await fetch(url, {
        method: a === 'create' ? 'POST' : 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(u),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (/relation .*dash_users.* does not exist|PGRST205/i.test(t)) {
          return json({ ok: false, error: 'As tabelas da equipe ainda não existem no Supabase. Rode o setup-equipe.sql (SQL Editor).' });
        }
        if (/funcao_cs|funcao_adm/i.test(t)) {
          return json({ ok: false, error: 'Falta rodar o setup-posvenda.sql no Supabase (funções CS e ADM).' });
        }
        const dup = /duplicate|unique/i.test(t);
        return json({ ok: false, error: dup ? 'Já existe um usuário com esse e-mail.' : 'Erro ao salvar.' });
      }
      return json({ ok: true, senhaTemporaria });
    }

    if (a === 'reset') {
      const senhaTemporaria = gerarSenhaTemp();
      const r = await fetch(`${SB_URL}/rest/v1/dash_users?id=eq.${Number(body.id) || 0}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ senha_hash: hashSenha(senhaTemporaria), trocar_senha: true, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return json({ ok: false, error: 'Erro ao resetar a senha.' });
      return json({ ok: true, senhaTemporaria });
    }

    if (a === 'delete') {
      const id = Number(body.id) || 0;
      // nome do atendente que está saindo (pra checar leads e quadro vinculados)
      const ru = await fetch(`${SB_URL}/rest/v1/dash_users?id=eq.${id}&select=nome&limit=1`, { headers: H });
      const nome = ru.ok ? String(((await ru.json())[0] || {}).nome || '').trim() : '';
      if (nome) {
        const nomeUrl = encodeURIComponent(nome);
        const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?atendente=eq.${nomeUrl}&select=lead_ref&limit=1`, {
          headers: { ...H, Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
        });
        const m = (rl.headers.get('content-range') || '').match(/\/(\d+)$/);
        const totalLeads = m ? Number(m[1]) : 0;
        let temQuadro = false;
        const rbq = await fetch(`${SB_URL}/rest/v1/kanban_boards?atendente=eq.${nomeUrl}&select=id&limit=1`, { headers: H });
        if (rbq.ok) temQuadro = (await rbq.json()).length > 0;

        const destino = String(body.destino || '').trim();
        // leads/quadro vinculados e nenhum destino definido → o painel pergunta primeiro
        if ((totalLeads > 0 || temQuadro) && !destino) {
          return json({ ok: false, precisaDestino: true, leads: totalLeads, temQuadro, atendente: nome });
        }
        if (destino && destino !== '(manter)') {
          // transfere leads e a propriedade do quadro pro novo responsável
          if (totalLeads > 0) {
            await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?atendente=eq.${nomeUrl}`, {
              method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
              body: JSON.stringify({ atendente: destino, updated_at: new Date().toISOString() }),
            });
          }
          if (temQuadro) {
            await fetch(`${SB_URL}/rest/v1/kanban_boards?atendente=eq.${nomeUrl}`, {
              method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
              body: JSON.stringify({ atendente: destino }),
            });
          }
        }
        // destino '(manter)': leads e quadro ficam como estão, só o acesso é removido
      }
      const r = await fetch(`${SB_URL}/rest/v1/dash_users?id=eq.${id}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('dash-users:', e?.message || e);
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

export const config = { path: '/api/dash-users' };
