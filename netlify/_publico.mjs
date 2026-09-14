/**
 * PÚBLICO-ALVO — filtro compartilhado usado pelas Automações (ver
 * netlify/functions/gatilhos.mjs e automacoes.mjs) pra restringir quem
 * recebe a mensagem.
 *
 *   { tipo:'todos' } | { tipo:'qualificador', valor:<chave> } |
 *   { tipo:'etiqueta', valor:<id> } | { tipo:'atendente', valor:<nome> } |
 *   { tipo:'pergunta', valor:<perguntaId>, valor2:<resposta esperada> }
 *
 * Pra gatilho 'agendado' é o único jeito de escolher a audiência (não tem
 * lead de origem — ver resolverPublico em wa-cron.mjs). Pra gatilho por
 * evento (tag/qualificador/agendamento) é opcional, aplicado como filtro
 * EXTRA em cima do lead que já disparou o evento (ver leadCombinaPublico).
 */
const TIPOS_PUBLICO = ['todos', 'qualificador', 'etiqueta', 'atendente', 'pergunta'];

export function limparPublico(pub) {
  const p = (pub && typeof pub === 'object') ? pub : {};
  const tipo = TIPOS_PUBLICO.includes(p.tipo) ? p.tipo : 'todos';
  if (tipo === 'todos') return { limpo: { tipo } };
  if (tipo === 'pergunta') {
    const valor = String(p.valor || '').trim().slice(0, 60);
    const valor2 = String(p.valor2 || '').trim().slice(0, 200);
    if (!valor || !valor2) return { erro: 'Escolha a pergunta e a resposta esperada.' };
    return { limpo: { tipo, valor, valor2 } };
  }
  if (!p.valor) return { erro: 'Escolha o público-alvo.' };
  const valor = tipo === 'etiqueta' ? Number(p.valor) : String(p.valor).trim().slice(0, 120);
  return { limpo: { tipo, valor } };
}

/* checa se UM lead já carregado bate com o público — usado pelos gatilhos
   por evento (tag/qualificador/agendamento), que já sabem qual lead
   disparou e só precisam decidir se ele também passa no filtro extra */
export function leadCombinaPublico(lead, publico) {
  const tipo = (publico && publico.tipo) || 'todos';
  if (tipo === 'todos' || !tipo) return true;
  if (tipo === 'qualificador') return String(lead.call_track || '') === String(publico.valor || '');
  if (tipo === 'atendente') return String(lead.atendente || '').trim() === String(publico.valor || '').trim();
  if (tipo === 'etiqueta') return Array.isArray(lead.etiqueta_ids) && lead.etiqueta_ids.includes(Number(publico.valor));
  if (tipo === 'pergunta') {
    let respostas = {};
    try { respostas = JSON.parse(lead.respostas_json || '{}'); } catch { return false; }
    const resp = respostas[publico.valor];
    return String(resp || '').trim().toLowerCase() === String(publico.valor2 || '').trim().toLowerCase();
  }
  return true;
}
