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

/* ================================================================
   GATILHOS "agendado" (reformulação de Automações — ver gatilhos.mjs) —
   cria os disparos das Automações vinculadas quando a hora/data chega.
   Público >10 leads é escalonado (1 msg a cada INTERVALO_CADENCIA_SEG)
   pra não estourar o cap de 60/execução nem arriscar bloqueio do número.
   ================================================================ */
const INTERVALO_CADENCIA_SEG = 8;
const LIMIAR_CADENCIA = 10;
const TZ = 'America/Sao_Paulo';

function diaLocal(d) { return new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ }); }   // yyyy-mm-dd
function horaLocalMin(d) {
  const s = new Date(d).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function minutosDeHHMM(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function preencherSimples(msg, lead) {
  const nome = String((lead && lead.nome) || '').trim().split(/\s+/)[0] || 'tudo bem';
  return String(msg || '').replaceAll('{{nome}}', nome);
}

/* pra quem a automação de gatilho "agendado" manda — os outros tipos de
   gatilho (tag/qualificador) já sabem pra quem sozinhos, não passam aqui */
async function resolverPublico(contaId, publico) {
  const tipo = (publico && publico.tipo) || 'todos';
  if (tipo === 'qualificador' && publico.valor) {
    const r = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&call_track=eq.${encodeURIComponent(publico.valor)}&select=lead_ref,nome,whatsapp`);
    return r.ok ? await r.json() : [];
  }
  if (tipo === 'etiqueta' && publico.valor) {
    const rl = await sb(`lead_etiquetas?conta_id=eq.${contaId}&etiqueta_id=eq.${Number(publico.valor)}&select=lead_ref`);
    const refs = rl.ok ? (await rl.json()).map((x) => x.lead_ref) : [];
    if (!refs.length) return [];
    const filtro = refs.map((r) => `"${r}"`).join(',');
    const r = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=in.(${filtro})&select=lead_ref,nome,whatsapp`);
    return r.ok ? await r.json() : [];
  }
  const r = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&select=lead_ref,nome,whatsapp`);
  return r.ok ? await r.json() : [];
}

async function processarGatilhosAgendados(contaId) {
  const rg = await sb(`gatilhos?conta_id=eq.${contaId}&tipo=eq.agendado&ativo=eq.true&select=id,config,disparado_em`);
  if (!rg.ok) return;   // setup-gatilhos.sql ainda não rodou nessa conta — segue sem essa etapa
  const gatilhosAgendados = await rg.json();
  if (!gatilhosAgendados.length) return;

  const agora = new Date();
  const hojeLocal = diaLocal(agora);
  const minutoAgora = horaLocalMin(agora);

  for (const g of gatilhosAgendados) {
    let cfg = {}; try { cfg = JSON.parse(g.config || '{}'); } catch { continue; }
    let deveDisparar = false;
    if (cfg.modo === 'unica') {
      deveDisparar = !g.disparado_em && cfg.data_hora && new Date(cfg.data_hora) <= agora;
    } else {
      const jaHoje = g.disparado_em && diaLocal(g.disparado_em) === hojeLocal;
      const diaCerto = cfg.frequencia !== 'semanal' || (Array.isArray(cfg.dias_semana) && cfg.dias_semana.includes(agora.getDay()));
      const minutoAlvo = minutosDeHHMM(cfg.hora);
      const dentroDaJanela = minutoAgora >= minutoAlvo && (minutoAgora - minutoAlvo) < 5;   // janela do próprio ciclo de 5min do cron
      deveDisparar = !jaHoje && diaCerto && !!cfg.hora && dentroDaJanela;
    }
    if (!deveDisparar) continue;

    const ra = await sb(`automacoes?conta_id=eq.${contaId}&gatilho_id=eq.${g.id}&ativa=eq.true&select=id,mensagem,destino,publico`);
    const automs = ra.ok ? await ra.json() : [];
    for (const am of automs) {
      if (!am.mensagem) continue;
      let publico = {}; try { publico = JSON.parse(am.publico || '{}'); } catch { /* 'todos' */ }
      const alvos = am.destino
        ? [{ lead_ref: '', nome: '', whatsapp: am.destino }]
        : (await resolverPublico(contaId, publico));
      const validos = alvos.filter((l) => String(l.whatsapp || '').replace(/\D/g, ''));
      const cadenciado = validos.length > LIMIAR_CADENCIA;
      for (let i = 0; i < validos.length; i++) {
        const lead = validos[i];
        const tel = String(lead.whatsapp || '').replace(/\D/g, '');
        const atrasoMs = cadenciado ? i * INTERVALO_CADENCIA_SEG * 1000 : 0;
        await sb('disparos', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            conta_id: contaId, telefone: tel, lead_ref: lead.lead_ref || '', nome: lead.nome || '',
            mensagem: preencherSimples(am.mensagem, lead),
            enviar_em: new Date(agora.getTime() + atrasoMs).toISOString(),
            status: 'pendente', origem: 'automacao:' + am.id,
          }),
        }).catch(() => {});
      }
    }
    await sb(`gatilhos?id=eq.${g.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ disparado_em: agora.toISOString() }) }).catch(() => {});
  }
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

  /* 1.5) gatilhos "agendado" das Automações reformuladas — cria os
     disparos (cadenciados quando o público passa de 10) */
  await processarGatilhosAgendados(contaId);

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
