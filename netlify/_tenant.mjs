/* ====================================================================
   Resolução de CONTA pra endpoints PÚBLICOS (o quiz e tudo que ele
   chama sem login) — cada assinante recebe um subdomínio próprio
   (ex: clinica-bella.quizzhub.com). A function lê o Host da requisição
   (Netlify sempre repassa o header original) e resolve a conta por
   `subdominio`, sem precisar de nenhum token.

   Endpoints AUTENTICADOS (dashboard) não usam isso — resolvem conta_id
   a partir do login (autenticarToken, em _tokens.mjs).

   Fallback: se o Host não bater com nenhum subdomínio cadastrado
   (ex: acessando direto pela URL do Netlify, sem domínio próprio
   configurado ainda), cai na primeira conta cadastrada — mesmo
   comportamento de hoje (single-tenant), pra não quebrar em dev/local
   nem antes do DNS por assinante estar pronto.
   ==================================================================== */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

let CONTA_PADRAO_CACHE = null; // cache em memória do processo (cold start) — evita 1 fetch a mais por request

export function extrairSubdominio(req) {
  const host = String(req.headers.get('host') || '').split(':')[0].toLowerCase();
  const partes = host.split('.');
  // "clinica-bella.quizzhub.com" → "clinica-bella" · "meusite.netlify.app" → sem subdomínio de conta (2 partes só)
  return partes.length >= 3 ? partes[0] : '';
}

/* devolve o id da conta (number) ou null se não achar nenhuma (nem a padrão) */
export async function resolverContaPorHost(req) {
  if (!SB_URL || !SB_KEY) return null;
  const sub = extrairSubdominio(req);
  try {
    if (sub) {
      const r = await fetch(`${SB_URL}/rest/v1/contas?subdominio=eq.${encodeURIComponent(sub)}&status=eq.ativa&select=id&limit=1`, { headers: H });
      if (r.ok) {
        const rows = await r.json();
        if (rows[0]) return rows[0].id;
      }
    }
  } catch { /* cai no fallback abaixo */ }

  // fallback: primeira conta cadastrada (dev local / domínio ainda sem subdomínio configurado)
  if (CONTA_PADRAO_CACHE) return CONTA_PADRAO_CACHE;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/contas?status=eq.ativa&select=id&order=id.asc&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      if (rows[0]) { CONTA_PADRAO_CACHE = rows[0].id; return rows[0].id; }
    }
  } catch { /* sem conta nenhuma cadastrada ainda */ }
  return null;
}
