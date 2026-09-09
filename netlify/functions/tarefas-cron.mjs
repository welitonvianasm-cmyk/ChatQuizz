/**
 * CRON DE TAREFAS — roda a cada 5 minutos (agendado no Netlify).
 * Multi-tenant: itera TODAS as contas ativas.
 *
 * Busca tarefas com `vencimento` já chegado (ou vencendo nos próximos 5min)
 * e `alertada=false`, cria 1 alerta na Central de Alertas (tabela `alertas`,
 * já usada pelo sino do painel) e marca `alertada=true` — nenhuma tela nova
 * de notificação é necessária, o sino já existente pega isso no próximo
 * polling (a cada 45s no painel).
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

async function contasAtivas() {
  const r = await sb('contas?status=eq.ativa&select=id');
  return r.ok ? await r.json() : [];
}

async function rodarConta(contaId) {
  const limite = new Date(Date.now() + 5 * 60000).toISOString();
  const r = await sb(`tarefas?conta_id=eq.${contaId}&concluida=eq.false&alertada=eq.false&vencimento=lte.${limite}&select=id,lead_ref,atendente,titulo`);
  const vencendo = r.ok ? await r.json() : [];
  let criados = 0;
  for (const t of vencendo) {
    // busca o nome do lead pra deixar o alerta legível (melhor-esforço)
    let leadNome = '';
    try {
      const rl = await sb(`diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(t.lead_ref)}&select=nome&limit=1`);
      if (rl.ok) { const rows = await rl.json(); leadNome = (rows[0] && rows[0].nome) || ''; }
    } catch { /* segue sem nome */ }

    await sb('alertas', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        conta_id: contaId, lead_ref: t.lead_ref, lead_nome: leadNome, atendente: t.atendente,
        tipo: 'tarefa', descricao: '⏰ ' + t.titulo, status: 'pendente',
      }),
    });
    await sb(`tarefas?id=eq.${t.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ alertada: true }) });
    criados++;
  }
  return criados;
}

export default async () => {
  try {
    const contas = await contasAtivas();
    let total = 0;
    for (const c of contas) total += await rodarConta(c.id);
    return new Response(`contas: ${contas.length}, alertas criados: ${total}`);
  } catch (e) {
    console.error('tarefas-cron:', e?.message || e);
    return new Response('erro', { status: 500 });
  }
};

export const config = { schedule: '*/5 * * * *' };
