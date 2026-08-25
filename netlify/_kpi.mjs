/**
 * Helper compartilhado dos KPIs de atendimento (ver setup-kpi-atendimento.sql).
 * Usado por wa-webhook.mjs e lead-admin.mjs — sempre o mesmo padrão de
 * gravação condicional, pra não divergir entre os pontos de disparo.
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

/* Grava primeiro_atendimento_em só na 1ª vez (nunca sobrescreve depois) —
   o próprio filtro no WHERE evita corrida entre gravações concorrentes.
   fonte: 'conversa' (mensagem real de WhatsApp) | 'atribuicao' (atendente
   atribuído antes de qualquer conversa). É a base de "Tempo até 1º
   atendimento" e "Leads Atendidos". Melhor-esforço: nunca trava o fluxo
   principal (webhook do WhatsApp / atualização do lead). */
export async function marcarPrimeiroAtendimento(contaId, lead_ref, fonte) {
  if (!lead_ref) return;
  try {
    await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${encodeURIComponent(lead_ref)}&primeiro_atendimento_em=is.null`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ primeiro_atendimento_em: new Date().toISOString(), primeiro_atendimento_fonte: fonte }),
    });
  } catch { /* melhor-esforço; KPI nunca pode travar o fluxo principal */ }
}
