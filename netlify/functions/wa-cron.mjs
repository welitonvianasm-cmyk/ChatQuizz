/**
 * CRON DO WHATSAPP — roda a cada 5 minutos (agendado no Netlify).
 * Multi-tenant: itera TODAS as contas ativas e roda a mesma lógica
 * escopada por conta_id em cada uma (toggle Disparos é por conta).
 *
 * 1. Lembrete de reunião (gatilho 'reuniao_1h'): varre o módulo Reuniões
 *    (os agendamentos reais dos leads — fonte única da verdade) e cria o
 *    disparo de quem tem Encontro começando em ~1h (janela 55-65 min).
 *    Reagendou/cancelou? O lembrete acompanha sozinho, porque a leitura
 *    é feita na hora — não existe agenda paralela. A chave única
 *    lead+data impede duplicados (lembrete_enviado).
 * 2. Fila de disparos: envia tudo que está 'pendente' e vencido,
 *    marcando enviado/falhou (sem reenvio).
 *
 * NADA é enviado com o toggle Disparos desligado (por conta).
 *
 * NOTA: a instância Evolution (EV_URL/EV_KEY/EV_INST) ainda é global —
 * todas as contas compartilham o mesmo número de WhatsApp até virar uma
 * conexão por conta (mesmo padrão já usado pro Cal.com/MentoriaHub).
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const EV_URL = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EV_KEY = process.env.EVOLUTION_KEY || '';
const EV_INST = process.env.EVOLUTION_INSTANCE || 'quizzhub';
// URL pública do site — Netlify preenche isso automaticamente (URL de produção)
const SITE = (process.env.URL || '').replace(/\/+$/, '');

const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

async function contasAtivas() {
  const r = await sb('contas?status=eq.ativa&select=id');
  return r.ok ? await r.json() : [];
}

async function disparosAtivos(contaId) {
  try {
    const r = await sb(`funnel_config?conta_id=eq.${contaId}&key=eq.wa_config&select=value&limit=1`);
    if (r.ok) { const rows = await r.json(); const v = rows[0] && JSON.parse(rows[0].value || '{}'); return !!(v && v.disparos); }
  } catch { /* desligado */ }
  return false;
}

function preencher(msg, lead) {
  const dt = lead.agendamento_em ? new Date(lead.agendamento_em) : null;
  const nome = String(lead.nome || '').trim().split(/\s+/)[0] || 'tudo bem';
  const data = dt ? dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }) : '';
  const horario = dt ? dt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '';
  const link = dt ? `${SITE}/call.html?t=${encodeURIComponent(lead.agendamento_em)}&n=${encodeURIComponent(lead.nome || '')}` : SITE;
  return String(msg || '')
    .replaceAll('{{nome}}', nome).replaceAll('{{data}}', data)
    .replaceAll('{{horario}}', horario).replaceAll('{{link_reuniao}}', link);
}

/* mesma extração de erro de whatsapp.mjs — duplicado de propósito (funções
   Netlify não compartilham módulo entre si nesse projeto) */
function textoDeErro(m) {
  if (m == null) return null;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((x) => textoDeErro(x) || JSON.stringify(x)).join('; ');
  if (typeof m === 'object') return textoDeErro(m.message) || JSON.stringify(m);
  return String(m);
}
async function enviar(telefone, texto) {
  if (!EV_URL || !EV_KEY) return { ok: false, error: 'Evolution não configurada' };
  const r = await fetch(`${EV_URL}/message/sendText/${EV_INST}`, {
    method: 'POST', headers: { apikey: EV_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: telefone, text: texto }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const detalhe = textoDeErro(d && (d.response?.message ?? d.message ?? d.error));
    return { ok: false, error: 'Evolution recusou (' + r.status + ')' + (detalhe ? ': ' + detalhe : '') };
  }
  return { ok: true };
}

/* roda o ciclo (lembretes + fila) pra UMA conta */
async function rodarConta(contaId) {
  const agora = Date.now();
  let ok = 0, falha = 0;

  /* 1) lembretes de reunião — direto do módulo Reuniões */
  const ra = await sb(`automacoes?conta_id=eq.${contaId}&gatilho=eq.reuniao_1h&ativa=eq.true&select=mensagem&limit=1`);
  const autom = ra.ok ? (await ra.json())[0] : null;
  if (autom && autom.mensagem) {
    const ini = new Date(agora + 55 * 60000).toISOString();
    const fim = new Date(agora + 65 * 60000).toISOString();
    const rl = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&agendado=eq.true&agendamento_em=gte.${ini}&agendamento_em=lte.${fim}&select=lead_ref,nome,whatsapp,agendamento_em,agendamento_status`);
    const leads = rl.ok ? await rl.json() : [];
    for (const l of leads) {
      if (['cancelado', 'reagendado'].includes(l.agendamento_status || '')) continue;   // reunião não vale mais
      const tel = String(l.whatsapp || '').replace(/\D/g, '');
      if (!tel) continue;
      // chave única = lembrete_enviado por lead+reunião (duplicado é ignorado)
      await sb('disparos', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({
          conta_id: contaId, telefone: tel, lead_ref: l.lead_ref, nome: l.nome || '',
          mensagem: preencher(autom.mensagem, l),
          enviar_em: new Date().toISOString(), status: 'pendente', origem: 'reuniao_1h',
          chave_unica: 'lembrete|' + l.lead_ref + '|' + l.agendamento_em,
        }),
      });
    }
  }

  /* 2) fila: envia os pendentes vencidos (uma vez só) */
  const limite = new Date(agora + 60000).toISOString();
  const rp = await sb(`disparos?conta_id=eq.${contaId}&status=eq.pendente&enviar_em=lte.${limite}&select=id,telefone,mensagem&order=enviar_em.asc&limit=60`);
  const fila = rp.ok ? await rp.json() : [];
  for (const d of fila) {
    const res = await enviar(d.telefone, d.mensagem);
    await sb(`disparos?id=eq.${d.id}&conta_id=eq.${contaId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(res.ok
        ? { status: 'enviado', enviado_em: new Date().toISOString(), erro: '' }
        : { status: 'falhou', erro: String(res.error || '').slice(0, 300) }),
    });
    res.ok ? ok++ : falha++;
    await new Promise((r2) => setTimeout(r2, 1200));   // pausa entre envios (proteção anti-bloqueio)
  }
  return { ok, falha };
}

export default async () => {
  try {
    const contas = await contasAtivas();
    let totalOk = 0, totalFalha = 0, contasProcessadas = 0;
    for (const c of contas) {
      if (!(await disparosAtivos(c.id))) continue;   // disparos desligados nesta conta
      const r = await rodarConta(c.id);
      totalOk += r.ok; totalFalha += r.falha; contasProcessadas++;
    }
    return new Response(`contas: ${contasProcessadas}, fila: ${totalOk} enviados, ${totalFalha} falhas`);
  } catch (e) {
    console.error('wa-cron:', e?.message || e);
    return new Response('erro', { status: 500 });
  }
};

export const config = { schedule: '*/5 * * * *' };
