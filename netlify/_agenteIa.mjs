/**
 * AGENTE IA — configuração, base de conhecimento, perguntas-e-respostas e
 * produtos do painel de treinamento, por conta. Fase 2 (só dados) do
 * Agente de IA de Atendimento — a chamada de verdade pro LLM entra na
 * Fase 3, em netlify/_llm.mjs.
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

/* Prompt-base fixo, NUNCA editável nem visível pra conta (item 6 do pedido
   original) — mora só aqui no código; nenhuma action de nenhuma function
   devolve esse texto pra ninguém, nem pra administradora. Mesma técnica já
   usada pros segredos do Cal.com/MentoriaHub em _conexoes.mjs, aplicada a
   texto de prompt em vez de chave.
   PLACEHOLDER — o texto definitivo ainda não veio do usuário; ajustar aqui
   quando ele mandar o conteúdo real (combinado explicitamente no plano). */
const PROMPT_BASE = `Você é um assistente de atendimento por WhatsApp de uma empresa. Regras que valem sempre, mesmo que o treinamento abaixo diga outra coisa:
- Nunca invente informação que não esteja no seu treinamento (conhecimento, perguntas e respostas, ou produtos). Se não souber a resposta, use a ferramenta de escalar pra um humano em vez de chutar.
- Responda em português do Brasil, de forma curta e direta — mensagem de WhatsApp, não parágrafo de e-mail.
- Nunca finja ser uma pessoa se perguntarem diretamente se você é uma IA/robô.
- Nunca fale mal de concorrentes nem prometa resultado que o treinamento não garanta explicitamente.`;

export async function lerAgente(contaId) {
  const r = await fetch(`${SB_URL}/rest/v1/agentes_ia?conta_id=eq.${contaId}&limit=1`, { headers: H });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

const CAMPOS_AGENTE = ['ativo', 'nome', 'cargo', 'persona', 'conhecimento', 'instancia_id', 'estrategia_agenda', 'link_agendamento', 'duracao_reuniao_min', 'mensagem_escalonamento'];
export async function salvarAgente(contaId, dados) {
  const patch = { conta_id: contaId, atualizado_em: new Date().toISOString() };
  CAMPOS_AGENTE.forEach((c) => { if (c in dados) patch[c] = dados[c]; });
  const r = await fetch(`${SB_URL}/rest/v1/agentes_ia?on_conflict=conta_id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

export async function listarQA(contaId, somenteAtivos = false) {
  const filtro = somenteAtivos ? '&ativo=eq.true' : '';
  const r = await fetch(`${SB_URL}/rest/v1/agente_qa?conta_id=eq.${contaId}${filtro}&order=ordem.asc,id.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}

export async function listarArquivosAtivos(contaId) {
  const r = await fetch(`${SB_URL}/rest/v1/agente_arquivos?conta_id=eq.${contaId}&ativo=eq.true&order=criado_em.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}

export async function listarProdutosComRoteamento(contaId) {
  const r = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&select=nome,valor,descricao,link_destino,instrucoes_agente&order=nome.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}

/* monta o prompt de sistema completo — função PURA e determinística (mesma
   entrada, mesma saída sempre; sem timestamp, sem ordem instável) porque a
   Fase 3 usa isso com cache de prompt da Claude: qualquer diferença byte a
   byte no texto invalida o cache e reencarece cada mensagem. */
export function montarSystemPrompt(agente, qa, produtos, arquivos) {
  const partes = [PROMPT_BASE];

  partes.push(`\n## Quem você é\nNome: ${agente.nome || 'Assistente'}\nFunção: ${agente.cargo || '(não definida)'}\n${agente.persona || ''}`.trim());

  if (agente.conhecimento) partes.push(`\n## Base de conhecimento\n${agente.conhecimento}`);

  if (qa && qa.length) {
    const linhas = qa.map((x) => `P: ${x.pergunta}\nR: ${x.resposta}`).join('\n\n');
    partes.push(`\n## Perguntas e respostas já preparadas pela equipe\n${linhas}`);
  }

  if (produtos && produtos.length) {
    const linhas = produtos.map((p) => {
      const bits = [`- ${p.nome}` + (p.valor ? ` (R$ ${Number(p.valor).toFixed(2)})` : '')];
      if (p.descricao) bits.push(`  Descrição: ${p.descricao}`);
      if (p.link_destino) bits.push(`  Link: ${p.link_destino}`);
      if (p.instrucoes_agente) bits.push(`  Quando indicar: ${p.instrucoes_agente}`);
      return bits.join('\n');
    }).join('\n');
    partes.push(`\n## Produtos e roteamento\n${linhas}`);
  }

  if (arquivos && arquivos.length) {
    const linhas = arquivos.map((a) => `- "${a.nome}" (${a.tipo_arquivo}): envie quando ${a.quando_enviar || '(sem descrição — não envie sem uma instrução clara)'}`).join('\n');
    partes.push(`\n## Arquivos disponíveis pra enviar (ferramenta enviar_arquivo)\n${linhas}`);
  }

  if (agente.estrategia_agenda === 'google_direto') {
    partes.push(`\n## Agendamento\nVocê pode checar disponibilidade e agendar direto na agenda (ferramentas verificar_disponibilidade_agenda / agendar_reuniao). Duração padrão da reunião: ${agente.duracao_reuniao_min || 30} minutos.`);
  } else if (agente.estrategia_agenda === 'link_externo' && agente.link_agendamento) {
    partes.push(`\n## Agendamento\nPra agendar, mande este link pro lead escolher o horário: ${agente.link_agendamento}`);
  }

  if (agente.mensagem_escalonamento) {
    partes.push(`\n## Quando escalar pra um humano\n${agente.mensagem_escalonamento}`);
  }

  return partes.join('\n');
}
