/**
 * AGENTE IA — loop de resposta de verdade (Fase 3). Chamado por
 * wa-webhook.mjs pra toda mensagem recebida de uma conta com o Agente IA
 * ativo (e não pausado nessa conversa).
 *
 * NÃO é uma Netlify Background Function — a conta está no plano gratuito
 * do Netlify, que não libera isso (só Pro+). É uma function síncrona
 * normal, com orçamento de tempo mais apertado: loop de ferramentas
 * limitado a poucas idas, sem empilhar transcrição de áudio na mesma
 * chamada (isso é tratado à parte na Fase 4). Se a conta migrar pro plano
 * Pro depois, dá pra virar Background Function sem mudar a lógica, só a
 * forma de disparo.
 *
 *   POST /api/agente-processar { contaId, telefone, leadRef, texto,
 *                                 instanciaNome, nomeLead, emailLead? }
 *   → { ok, respondeu, escalado? }
 *
 * Sem autenticação de usuário (não é o dashboard chamando) — protegido só
 * por rodar server-to-server a partir do próprio wa-webhook.mjs. Não expõe
 * rota pensada pra ser chamada de fora.
 */
import { lerAgente, listarQA, listarArquivosAtivos, listarProdutosComRoteamento, montarSystemPrompt, lerEstadoConversa, definirPausaConversa } from '../_agenteIa.mjs';
import { chamarClaude, textoDaResposta, chamadasDeFerramenta, configurada as llmConfigurada } from '../_llm.mjs';
import { enviarTexto, enviarMidia } from '../_evolution.mjs';
import { consultarDisponibilidade, sincronizarEventoGoogle } from '../_googleAgenda.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const TABLE = 'diag_instagram_leads';
const BUCKET = 'agente-arquivos';
const MAX_IDAS_FERRAMENTA = 3;
const HIST_LIMITE = 20;

function construirFerramentas(agente, arquivos) {
  const tools = [{
    name: 'escalar_para_humano',
    description: 'Use quando não souber responder algo com confiança, quando o lead pedir claramente pra falar com uma pessoa, ou quando a situação pedir julgamento humano (reclamação, negociação de preço não coberta pelo treinamento, etc). Isso pausa você nessa conversa e avisa a equipe — depois disso, não tente responder mais nada até um humano retomar.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'Resumo curto do porquê está escalando' } }, required: ['motivo'] },
  }];
  if (agente.estrategia_agenda === 'google_direto') {
    tools.push({
      name: 'verificar_disponibilidade_agenda',
      description: 'Verifica os horários já ocupados num dia específico, pra você poder sugerir um horário livre antes de agendar.',
      input_schema: { type: 'object', properties: { data: { type: 'string', description: 'Data no formato AAAA-MM-DD' } }, required: ['data'] },
    });
    tools.push({
      name: 'agendar_reuniao',
      description: 'Agenda a reunião de verdade no horário já escolhido e confirmado pelo lead.',
      input_schema: { type: 'object', properties: { inicio_iso: { type: 'string', description: 'Data e hora de início em ISO 8601 com fuso, ex: 2026-09-05T14:00:00-03:00' } }, required: ['inicio_iso'] },
    });
  }
  if (arquivos.length) {
    tools.push({
      name: 'enviar_arquivo',
      description: 'Envia um arquivo (imagem ou PDF) já cadastrado no treinamento pro lead, no momento certo da conversa.',
      input_schema: { type: 'object', properties: { nome: { type: 'string', description: 'Nome exato do arquivo, como aparece na lista de "Arquivos disponíveis pra enviar"' } }, required: ['nome'] },
    });
  }
  return tools;
}

async function gerarUrlAssinada(storagePath) {
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
      method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    const caminho = d.signedURL || d.signedUrl || '';
    return caminho ? `${SB_URL}/storage/v1${caminho}` : '';
  } catch { return ''; }
}

async function criarAlerta(contaId, leadRef, nomeLead, motivo) {
  try {
    await fetch(`${SB_URL}/rest/v1/alertas`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ conta_id: contaId, lead_ref: leadRef || '', lead_nome: nomeLead || '', atendente: '', tipo: 'agente_ia', descricao: 'IA precisa de ajuda: ' + String(motivo || '').slice(0, 300), status: 'pendente' }),
    });
  } catch { /* alerta é melhor-esforço */ }
}

/* espelha o agendamento no lead — mesmo padrão de save-lead.mjs/lead-admin.mjs
   quando o Google Agenda confirma um evento; origem 'agente_ia' distingue de
   quando é o próprio quiz ou a equipe que agenda. */
async function marcarLeadAgendado(contaId, leadRef, inicioISO, evento) {
  if (!leadRef) return;
  const patch = { agendado: true, status: 'agendado', agendamento_em: inicioISO, agendamento_status: '', agendamento_origem: 'agente_ia', etapa: 'agendado', updated_at: new Date().toISOString() };
  if (evento && evento.id) patch.google_event_id = evento.id;
  if (evento && evento.meetLink) patch.video_url = evento.meetLink;
  let r = await fetch(`${SB_URL}/rest/v1/${TABLE}?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
  if (!r.ok) {
    delete patch.etapa;   // coluna pode não existir ainda (setup-kanban3.sql)
    await fetch(`${SB_URL}/rest/v1/${TABLE}?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
  }
}

async function executarFerramenta(nome, input, ctx) {
  if (nome === 'escalar_para_humano') {
    await criarAlerta(ctx.contaId, ctx.leadRef, ctx.nomeLead, input.motivo);
    await definirPausaConversa(ctx.contaId, ctx.telefone, true, 'agente_ia');
    ctx.escalado = true;
    return { ok: true, aviso: 'Encaminhado pra um humano — não tente mais responder nessa conversa.' };
  }
  if (nome === 'verificar_disponibilidade_agenda') {
    const dia = String(input.data || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return { ok: false, erro: 'Data inválida, use AAAA-MM-DD.' };
    const inicioISO = `${dia}T09:00:00-03:00`;
    const fimISO = `${dia}T18:00:00-03:00`;
    const ocupados = await consultarDisponibilidade(ctx.contaId, { inicioISO, fimISO });
    if (ocupados === null) return { ok: false, erro: 'Não consegui checar a agenda agora — tente sugerir horário e confirmar por texto mesmo.' };
    return { ok: true, horario_comercial: '09:00 às 18:00 (America/Sao_Paulo)', ocupados };
  }
  if (nome === 'agendar_reuniao') {
    const inicio = new Date(input.inicio_iso);
    if (isNaN(inicio)) return { ok: false, erro: 'Data/hora inválida.' };
    const fim = new Date(inicio.getTime() + (ctx.agente.duracao_reuniao_min || 30) * 60000);
    const evento = await sincronizarEventoGoogle(ctx.contaId, {
      titulo: 'Encontro — ' + (ctx.nomeLead || 'Lead'),
      inicioISO: inicio.toISOString(), fimISO: fim.toISOString(),
      participanteNome: ctx.nomeLead, participanteEmail: ctx.emailLead,
    });
    if (!evento) return { ok: false, erro: 'Não consegui agendar agora — avise que vai confirmar em instantes, ou escale pra um humano.' };
    await marcarLeadAgendado(ctx.contaId, ctx.leadRef, inicio.toISOString(), evento);
    ctx.agendado = true;
    return { ok: true, agendado_em: inicio.toISOString(), link_reuniao: evento.meetLink || '' };
  }
  if (nome === 'enviar_arquivo') {
    const alvo = String(input.nome || '').trim().toLowerCase();
    const arq = ctx.arquivos.find((a) => a.nome.toLowerCase() === alvo);
    if (!arq) return { ok: false, erro: 'Arquivo não encontrado no treinamento.' };
    const url = await gerarUrlAssinada(arq.storage_path);
    if (!url) return { ok: false, erro: 'Não consegui preparar o arquivo agora.' };
    const r = await enviarMidia(ctx.instanciaNome, ctx.telefone, url, arq.mimetype, arq.nome);
    if (!r.ok) return { ok: false, erro: r.error };
    return { ok: true };
  }
  return { ok: false, erro: 'ferramenta desconhecida' };
}

async function carregarHistorico(contaId, telefone) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&telefone=eq.${encodeURIComponent(telefone)}&select=direcao,texto,tipo&order=criado_em.desc&limit=${HIST_LIMITE}`, { headers: H });
  if (!r.ok) return [];
  const linhas = (await r.json()).reverse();
  const msgs = [];
  linhas.forEach((m) => {
    const texto = m.texto || (m.tipo && m.tipo !== 'texto' ? `[${m.tipo}]` : '');
    if (!texto) return;
    const role = m.direcao === 'out' ? 'assistant' : 'user';
    // Claude exige alternância estrita user/assistant — junta mensagens seguidas do mesmo lado
    const ultima = msgs[msgs.length - 1];
    if (ultima && ultima.role === role) ultima.content += '\n' + texto;
    else msgs.push({ role, content: texto });
  });
  return msgs;
}

async function gravarMensagemSaida(contaId, telefone, leadRef, texto, instanciaNome, waId) {
  try {
    await fetch(`${SB_URL}/rest/v1/wa_mensagens`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ conta_id: contaId, telefone, lead_ref: leadRef || '', direcao: 'out', tipo: 'texto', texto: String(texto).slice(0, 4000), quem: 'Agente IA', wa_id: waId || '', lida: true, instancia: instanciaNome || '' }),
    });
  } catch { /* histórico é melhor-esforço */ }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  let body = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const contaId = Number(body.contaId) || 0;
  const telefone = String(body.telefone || '').trim();
  const leadRef = String(body.leadRef || '').trim();
  const textoEntrada = String(body.texto || '').trim();
  const instanciaNome = String(body.instanciaNome || '').trim();
  const nomeLead = String(body.nomeLead || '').trim();
  const emailLead = String(body.emailLead || '').trim();
  if (!contaId || !telefone || !textoEntrada) return json({ ok: false, error: 'dados incompletos' });

  try {
    if (!llmConfigurada()) return json({ ok: false, respondeu: false, error: 'ANTHROPIC_API_KEY não configurada.' });

    const agente = await lerAgente(contaId);
    if (!agente || !agente.ativo) return json({ ok: true, respondeu: false, motivo: 'agente_inativo' });
    if (!instanciaNome) return json({ ok: true, respondeu: false, motivo: 'sem_instancia' });

    const estado = await lerEstadoConversa(contaId, telefone);
    if (estado.ia_pausada) return json({ ok: true, respondeu: false, motivo: 'pausado' });

    const [qa, produtos, arquivos, historico] = await Promise.all([
      listarQA(contaId, true),
      listarProdutosComRoteamento(contaId),
      listarArquivosAtivos(contaId),
      carregarHistorico(contaId, telefone),
    ]);

    const system = montarSystemPrompt(agente, qa, produtos, arquivos);
    const tools = construirFerramentas(agente, arquivos);
    const ctx = { contaId, telefone, leadRef, nomeLead, emailLead, agente, arquivos, instanciaNome, escalado: false, agendado: false };

    const messages = [...historico];
    if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: textoEntrada });

    let textoFinal = '';
    for (let ida = 0; ida < MAX_IDAS_FERRAMENTA; ida++) {
      const r = await chamarClaude({ system, messages, tools, maxTokens: 1024 });
      if (!r.ok) { console.error('agente-processar: falha na Claude:', r.error); return json({ ok: false, error: r.error }); }
      const resposta = r.resposta;
      const chamadas = chamadasDeFerramenta(resposta);
      if (!chamadas.length) { textoFinal = textoDaResposta(resposta); break; }

      messages.push({ role: 'assistant', content: resposta.content });
      const resultados = [];
      for (const c of chamadas) {
        const resultado = await executarFerramenta(c.name, c.input || {}, ctx);
        resultados.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(resultado) });
      }
      messages.push({ role: 'user', content: resultados });

      if (ctx.escalado) { textoFinal = textoDaResposta(resposta) || ''; break; }   // já pausou; não continua o loop
    }

    // corrida: um humano pode ter assumido a conversa enquanto a IA processava
    const estadoAgora = await lerEstadoConversa(contaId, telefone);
    if (estadoAgora.ia_pausada) return json({ ok: true, respondeu: false, motivo: 'pausado_durante_processamento' });

    if (textoFinal) {
      const envio = await enviarTexto(instanciaNome, telefone, textoFinal);
      if (envio.ok) await gravarMensagemSaida(contaId, telefone, leadRef, textoFinal, instanciaNome, envio.wa_id);
      else console.error('agente-processar: falha ao enviar:', envio.error);
    }

    return json({ ok: true, respondeu: !!textoFinal, escalado: ctx.escalado, agendado: ctx.agendado });
  } catch (e) {
    console.error('agente-processar:', e?.message || e);
    return json({ ok: false, error: 'error' }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/api/agente-processar' };
