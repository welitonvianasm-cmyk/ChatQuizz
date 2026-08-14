/* ====================================================================
   Conexões configuráveis pelo painel (hoje: Cal.com). A chave pode vir
   de variável de ambiente (CALCOM_API_KEY) OU ser salva pelo painel
   (aba Configurações → Conexões) — a variável de ambiente sempre tem
   prioridade, pra não atrapalhar quem já configura por lá.
   Guardado em funnel_config (mesmo padrão já usado no resto do
   projeto), nunca devolvido de volta pro navegador em texto puro.
   ==================================================================== */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const CHAVE_CALCOM = 'conexao_calcom';

export async function lerConexaoCalcom() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/funnel_config?key=eq.${CHAVE_CALCOM}&select=value&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      const v = rows[0] && JSON.parse(rows[0].value || '{}');
      if (v && typeof v === 'object') return v;
    }
  } catch { /* nada salvo ainda */ }
  return {};
}

export async function salvarConexaoCalcom(dados) {
  await fetch(`${SB_URL}/rest/v1/funnel_config?on_conflict=key`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: CHAVE_CALCOM, value: JSON.stringify(dados || {}), updated_at: new Date().toISOString() }),
  });
}

export async function obterCalcomApiKey() {
  if (process.env.CALCOM_API_KEY) return process.env.CALCOM_API_KEY;
  const salvo = await lerConexaoCalcom();
  return salvo.api_key || '';
}
