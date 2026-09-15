/**
 * AUTOMAÇÕES — mensagens automáticas 100% editáveis (moram no banco).
 *
 *   { token, action:'listar' }                                    → { ok, automacoes }
 *   { token, action:'criar',  nome, gatilho, mensagem, gatilho_id?, publico?, instancia_id? }  (admin)
 *   { token, action:'editar', id, nome?, gatilho?, mensagem?, ativa?, gatilho_id?, publico?, instancia_id? }  (admin)
 *   { token, action:'excluir', id }                               (admin)
 *
 * `instancia_id` (opcional, só relevante pra quem tem mais de 1 WhatsApp
 * conectado — setup-automacoes-instancia.sql) escolhe por qual número os
 * disparos EM MASSA/AGENDADOS dessa automação saem (gatilho 'agendado',
 * 'agendamento', 'reuniao_1h', e o atraso de tag/qualificador — todos
 * passam pela fila, ver netlify/functions/wa-cron.mjs). Vazio/0 = número
 * padrão da conta, comportamento de sempre. Os disparos IMEDIATOS de tag/
 * qualificador (sem atraso) NÃO usam isso — continuam saindo pelo número
 * que já está conversando com o lead (continuidade), de propósito.
 *
 * Gatilhos LEGADOS (continuam funcionando, nada mudou neles): 'reuniao_1h'
 * (lembrete 1h antes da reunião) | 'lead_vip' (alerta de lead prioritário,
 * dispara quando o qualificador computado do lead bate com
 * `qualificador_alvo`; a mensagem vai pro número de staff em `destino`, não
 * pro lead) | 'manual'.
 *
 * Gatilho NOVO (reformulação — ver netlify/functions/gatilhos.mjs): quando
 * `gatilho === 'custom'`, a automação usa `gatilho_id` (aponta pra um
 * gatilho criado pelo usuário em Gestão > Gatilhos: agendado/tag/
 * qualificador/agendamento) em vez do texto fixo. `publico` (ver
 * netlify/_publico.mjs) escolhe quem recebe — pra gatilho 'agendado' é
 * OBRIGATÓRIO (não tem lead de origem); pra tag/qualificador/agendamento é
 * um filtro EXTRA opcional em cima do lead que já disparou o evento.
 */
import { temConfig, autenticarToken } from '../_tokens.mjs';
import { limparPublico } from '../_publico.mjs';
import { obterInstancia } from '../_evolution.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const AVISO_SQL = 'Falta rodar o setup-whatsapp.sql no Supabase (módulo WhatsApp).';
const AVISO_SQL_VIP = 'Falta rodar o setup-automacoes-vip.sql no Supabase (colunas do alerta de lead prioritário).';
const AVISO_SQL_GATILHOS = 'Falta rodar o setup-gatilhos.sql no Supabase (módulo Gatilhos).';
const AVISO_SQL_INSTANCIA = 'Falta rodar o setup-automacoes-instancia.sql no Supabase (escolha de número por automação).';
const GATILHOS = ['manual', 'reuniao_1h', 'lead_vip', 'custom'];
const COLS_VIP = ['destino', 'qualificador_alvo'];   // adicionadas por setup-automacoes-vip.sql, não por setup-whatsapp.sql
const COLS_GATILHOS = ['gatilho_id', 'publico'];     // adicionadas por setup-gatilhos.sql
const COLS_INSTANCIA = ['instancia_id'];             // adicionada por setup-automacoes-instancia.sql

// olha a mensagem de erro do Postgres pra apontar a coluna que falta de
// verdade — sem isso, qualquer erro (mesmo um migration diferente, ainda
// pendente) era rotulado como "falta o setup-whatsapp.sql"
function colunaFaltando(errText) {
  const m = errText.match(/column [\w."]+\.(\w+) does not exist/);
  return m ? m[1] : null;
}
function avisoPara(faltando) {
  if (faltando && COLS_VIP.includes(faltando)) return AVISO_SQL_VIP;
  if (faltando && COLS_GATILHOS.includes(faltando)) return AVISO_SQL_GATILHOS;
  if (faltando && COLS_INSTANCIA.includes(faltando)) return AVISO_SQL_INSTANCIA;
  return AVISO_SQL;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!temConfig()) return json({ error: 'not configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const auth = await autenticarToken(req.headers.get('x-dash-token') || body.token || '');
  if (!auth.ok) return json({ error: 'unauthorized' }, 401);
  const contaId = auth.contaId;

  try {
    const a = body.action;
    const id = Number(body.id) || 0;

    if (a === 'listar') {
      let colsAtivas = 'id,nome,gatilho,mensagem,ativa,destino,qualificador_alvo,gatilho_id,publico,instancia_id,criado_em';
      let r = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&select=${colsAtivas}&order=criado_em.asc`, { headers: H });
      if (!r.ok) {
        const errText = await r.clone().text().catch(() => '');
        const faltando = colunaFaltando(errText);
        if (faltando && COLS_INSTANCIA.includes(faltando)) {
          // ainda sem setup-automacoes-instancia.sql: lista sem instancia_id
          colsAtivas = 'id,nome,gatilho,mensagem,ativa,destino,qualificador_alvo,gatilho_id,publico,criado_em';
          r = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&select=${colsAtivas}&order=criado_em.asc`, { headers: H });
        }
      }
      if (!r.ok) {
        const errText = await r.clone().text().catch(() => '');
        const faltando = colunaFaltando(errText);
        if (faltando && COLS_GATILHOS.includes(faltando)) {
          // ainda sem setup-gatilhos.sql: lista sem gatilho_id/publico
          colsAtivas = 'id,nome,gatilho,mensagem,ativa,destino,qualificador_alvo,criado_em';
          r = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&select=${colsAtivas}&order=criado_em.asc`, { headers: H });
        }
      }
      if (!r.ok) {
        const errText = await r.clone().text().catch(() => '');
        const faltando = colunaFaltando(errText);
        if (faltando && COLS_VIP.includes(faltando)) {
          // ainda sem setup-automacoes-vip.sql: lista sem essas 2 colunas em vez de falhar tudo
          colsAtivas = 'id,nome,gatilho,mensagem,ativa,criado_em';
          r = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&select=${colsAtivas}&order=criado_em.asc`, { headers: H });
        }
      }
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error('automacoes listar error:', r.status, errText.slice(0, 200));
        return json({ ok: false, error: avisoPara(colunaFaltando(errText)) });
      }
      let automacoes = await r.json();
      automacoes = automacoes.map((am) => ({ destino: '', qualificador_alvo: '', gatilho_id: null, publico: '{}', instancia_id: null, ...am }));
      automacoes.forEach((am) => { try { am.publico = JSON.parse(am.publico || '{}'); } catch { am.publico = {}; } });
      // número de staff é dado sensível — só a administradora vê de verdade
      if (!auth.admin) automacoes = automacoes.map((am) => ({ ...am, destino: am.destino ? '••••••' : '' }));
      return json({ ok: true, automacoes });
    }

    if (!auth.admin) return json({ ok: false, error: 'Somente a administradora gerencia as automações.' });

    if (a === 'criar' || a === 'editar') {
      const patch = {};
      if ('nome' in body || a === 'criar') {
        patch.nome = String(body.nome || '').trim().slice(0, 120);
        if (!patch.nome) return json({ ok: false, error: 'Dê um nome à automação.' });
      }
      if ('gatilho' in body || a === 'criar') {
        patch.gatilho = String(body.gatilho || 'manual').trim();
        if (!GATILHOS.includes(patch.gatilho)) return json({ ok: false, error: 'gatilho inválido' });
      }
      if ('mensagem' in body || a === 'criar') patch.mensagem = String(body.mensagem || '').slice(0, 3000);
      if ('destino' in body) patch.destino = String(body.destino || '').replace(/\D/g, '').slice(0, 20);
      if ('qualificador_alvo' in body) patch.qualificador_alvo = String(body.qualificador_alvo || '').trim().slice(0, 40);
      if ('ativa' in body) patch.ativa = !!body.ativa;
      if (patch.gatilho === 'custom' || ('gatilho_id' in body)) {
        const gatilhoId = Number(body.gatilho_id) || 0;
        if (patch.gatilho === 'custom' && !gatilhoId) return json({ ok: false, error: 'Escolha um gatilho.' });
        if (gatilhoId) {
          const rg = await fetch(`${SB_URL}/rest/v1/gatilhos?id=eq.${gatilhoId}&conta_id=eq.${contaId}&select=id,tipo&limit=1`, { headers: H });
          const gat = rg.ok ? (await rg.json())[0] : null;
          if (!gat) return json({ ok: false, error: 'Gatilho não encontrado.' });
          patch.gatilho_id = gatilhoId;
          // 'agendado' não tem lead de origem: público decide pra quem manda.
          // tag/qualificador/agendamento já sabem pra quem mandar sozinhos — público
          // aqui é um filtro EXTRA opcional (ex.: só manda se o atendente for X).
          // Sem publico no body cai em 'todos' (sem filtro) nos dois casos.
          const pv = limparPublico(body.publico);
          if (pv.erro) return json({ ok: false, error: pv.erro });
          patch.publico = JSON.stringify(pv.limpo);
        } else {
          patch.gatilho_id = null;
          patch.publico = JSON.stringify({});
        }
      }
      if ('instancia_id' in body) {
        const instId = Number(body.instancia_id) || 0;
        if (!instId) {
          patch.instancia_id = null;   // volta pro número padrão da conta
        } else {
          const inst = await obterInstancia(contaId, instId);
          if (!inst) return json({ ok: false, error: 'Número não encontrado.' });
          patch.instancia_id = instId;
        }
      }
      if (a === 'criar') patch.conta_id = contaId;
      const salvar = () => a === 'criar'
        ? fetch(`${SB_URL}/rest/v1/automacoes`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
        : fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      let r = await salvar();
      if (!r.ok) {
        const errText = await r.clone().text().catch(() => '');
        const faltando = colunaFaltando(errText);
        // instancia_id manda em TODA automação agora (mesmo quem nunca usou
        // esse recurso) — se a conta ainda não rodou o setup-automacoes-
        // -instancia.sql, não pode travar a edição de automações antigas
        // por causa de 1 coluna nova opcional; tenta de novo sem ela
        if (faltando === 'instancia_id' && 'instancia_id' in patch) {
          delete patch.instancia_id;
          r = await salvar();
        }
      }
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error('automacoes salvar error:', r.status, errText.slice(0, 200));
        return json({ ok: false, error: avisoPara(colunaFaltando(errText)) });
      }
      return json({ ok: true });
    }

    if (a === 'excluir') {
      const r = await fetch(`${SB_URL}/rest/v1/automacoes?id=eq.${id}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
      return json({ ok: r.ok });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('automacoes:', e?.message || e);
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

export const config = { path: '/api/automacoes' };
