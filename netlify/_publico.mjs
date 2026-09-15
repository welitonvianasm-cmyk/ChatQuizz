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

/* RECONCILIAÇÃO — um disparo criado por um gatilho por evento (tag/
   qualificador/agendamento) fica pendente na fila até `enviar_em` chegar
   (imediato ou atrasado, ver `atraso` em gatilhos.mjs). Se nesse meio-tempo
   o lead deixar de bater com a condição que gerou o disparo — perdeu a
   etiqueta, mudou de qualificador, foi passado pra outro atendente (quando
   isso é o filtro `publico` da automação), ou a reunião foi cancelada —
   esse disparo ainda pendente É CANCELADO aqui, pra não mandar uma
   mensagem que não faz mais sentido. Chamado depois de qualquer mudança no
   lead que possa afetar isso: netlify/functions/etiquetas.mjs (mudou tag)
   e lead-admin.mjs (mudou atendente/qualificador/status do agendamento).
   Reagendamento (data mudou, sem cancelar) é tratado à parte, em
   lead-admin.mjs (cancelarLembretesPendentes), porque o cron recria um
   disparo novo pro horário certo sozinho — aqui só cobre "não vale mais". */
export async function reconciliarDisparosPendentes(SB_URL, H, contaId, leadRef) {
  try {
    const rd = await fetch(`${SB_URL}/rest/v1/disparos?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&status=eq.pendente&origem=like.automacao:*&select=id,origem`, { headers: H });
    if (!rd.ok) return;
    const pendentes = await rd.json();
    if (!pendentes.length) return;

    const amIds = [...new Set(pendentes.map((d) => Number(String(d.origem).split(':')[1])).filter(Boolean))];
    if (!amIds.length) return;
    const ra = await fetch(`${SB_URL}/rest/v1/automacoes?conta_id=eq.${contaId}&id=in.(${amIds.join(',')})&select=id,gatilho_id,publico`, { headers: H });
    const automs = ra.ok ? await ra.json() : [];
    if (!automs.length) return;

    const gIds = [...new Set(automs.map((a) => a.gatilho_id).filter(Boolean))];
    const rg = gIds.length ? await fetch(`${SB_URL}/rest/v1/gatilhos?conta_id=eq.${contaId}&id=in.(${gIds.join(',')})&select=id,tipo,config`, { headers: H }) : null;
    const gatilhosPorId = new Map((rg && rg.ok ? await rg.json() : []).map((g) => {
      let c = {}; try { c = JSON.parse(g.config || '{}'); } catch { /* vazio */ }
      return [g.id, { tipo: g.tipo, config: c }];
    }));

    const rl = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=atendente,call_track,respostas_json,agendamento_status&limit=1`, { headers: H });
    const lead = rl.ok ? (await rl.json())[0] : null;
    if (!lead) return;
    const rEt = await fetch(`${SB_URL}/rest/v1/lead_etiquetas?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(leadRef)}&select=etiqueta_id`, { headers: H });
    const leadAtual = { ...lead, etiqueta_ids: rEt.ok ? (await rEt.json()).map((x) => x.etiqueta_id) : [] };

    const automPorId = new Map(automs.map((a) => {
      let p = {}; try { p = JSON.parse(a.publico || '{}'); } catch { /* vazio */ }
      return [a.id, { gatilho_id: a.gatilho_id, publico: p }];
    }));

    const idsCancelar = [];
    for (const d of pendentes) {
      const am = automPorId.get(Number(String(d.origem).split(':')[1]));
      if (!am) continue;
      const g = gatilhosPorId.get(am.gatilho_id);
      let aindaVale = true;
      if (g && g.tipo === 'tag') aindaVale = leadAtual.etiqueta_ids.includes(Number(g.config.etiqueta_id));
      else if (g && g.tipo === 'qualificador') aindaVale = leadAtual.call_track === g.config.qualificador_chave;
      else if (g && g.tipo === 'agendamento') aindaVale = !['cancelado', 'reagendado'].includes(leadAtual.agendamento_status || '');
      if (aindaVale) aindaVale = leadCombinaPublico(leadAtual, am.publico);
      if (!aindaVale) idsCancelar.push(d.id);
    }
    if (!idsCancelar.length) return;
    await fetch(`${SB_URL}/rest/v1/disparos?id=in.(${idsCancelar.join(',')})&conta_id=eq.${contaId}&status=eq.pendente`, { method: 'DELETE', headers: H });
  } catch { /* reconciliação é melhor-esforço, nunca derruba a ação principal */ }
}
