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
 * Cada conta manda pela sua própria instância padrão (ver netlify/_evolution.mjs
 * — desde a Fase 1 do WhatsApp multi-instância, não é mais um número global).
 */
import { obterInstanciaPadrao, enviarTexto } from '../_evolution.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
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
  // sem id/v, call.html nunca mostra o botão "Entrar na reunião" (só aparece
  // quando tem booking_uid) — antes o lembrete automático nunca levava esses
  // parâmetros, então quem chegava por aqui nunca via o botão
  let link = SITE;
  if (dt) {
    link = `${SITE}/call.html?t=${encodeURIComponent(lead.agendamento_em)}&n=${encodeURIComponent(lead.nome || '')}`;
    if (lead.booking_uid) link += `&id=${encodeURIComponent(lead.booking_uid)}`;
    if (lead.video_url) link += `&v=${encodeURIComponent(lead.video_url)}`;
  }
  return String(msg || '')
    .replaceAll('{{nome}}', nome).replaceAll('{{data}}', data)
    .replaceAll('{{horario}}', horario).replaceAll('{{link_reuniao}}', link);
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
    const rl = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&agendado=eq.true&agendamento_em=gte.${ini}&agendamento_em=lte.${fim}&select=lead_ref,nome,whatsapp,agendamento_em,agendamento_status,booking_uid,video_url`);
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

  /* 2) fila: envia os pendentes vencidos (uma vez só), pela instância padrão da conta */
  const inst = await obterInstanciaPadrao(contaId);
  if (!inst) return { ok, falha };   // conta sem nenhum número conectado ainda

  const limite = new Date(agora + 60000).toISOString();
  const rp = await sb(`disparos?conta_id=eq.${contaId}&status=eq.pendente&enviar_em=lte.${limite}&select=id,telefone,mensagem&order=enviar_em.asc&limit=60`);
  const candidatos = rp.ok ? await rp.json() : [];
  // reivindica as linhas ANTES de mandar (PATCH ainda filtrado por
  // status=eq.pendente — só quem realmente seguia pendente nesse instante
  // volta na resposta) — sem isso, duas execuções do cron próximas uma da
  // outra podiam pegar e mandar a mesma mensagem duas vezes (mesmo bug já
  // corrigido no quiz-suavitatis, commit c668069, envio triplicado)
  let fila = [];
  if (candidatos.length) {
    const ids = candidatos.map((d) => d.id).join(',');
    const rc = await sb(`disparos?id=in.(${ids})&conta_id=eq.${contaId}&status=eq.pendente`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'enviando' }),
    });
    const reivindicadas = rc.ok ? await rc.json().catch(() => []) : [];
    const porId = new Map(candidatos.map((d) => [d.id, d]));
    fila = reivindicadas.map((rw) => porId.get(rw.id)).filter(Boolean);
  }
  for (const d of fila) {
    const res = await enviarTexto(inst.nome_instancia, d.telefone, d.mensagem);
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
