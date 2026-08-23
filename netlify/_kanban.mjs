/* ====================================================================
   Sincronização com os quadros Kanban (Quadro Funil) — extraído de
   lead-admin.mjs pra poder ser reaproveitado por qualquer automação que
   converta/mova um lead sozinha, sem passar pela equipe (ex.: o webhook
   de pagamento, que converte o lead direto quando o pagamento chega).
   ==================================================================== */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

/* colunas oficiais do funil (espelho do kanban.mjs) */
const FUNIL = [
  { tipo: 'atribuido', nome: 'Atribuído' },
  { tipo: 'conversa', nome: 'Em Conversa' },
  { tipo: 'followup', nome: 'Follow-up' },
  { tipo: 'agendado', nome: 'Agendado' },
  { tipo: 'perdido', nome: '✕ Perdido' },
  { tipo: 'convertido', nome: '✓ Convertido' },
];

/* Posiciona o lead no quadro Kanban do atendente dele, na coluna oficial
   `tipoCol` — criando o card (e as colunas do funil) se precisar, e tirando
   o lead dos quadros de outros atendentes. Melhor-esforço: falha em silêncio. */
export async function moverNoKanban(contaId, lead_ref, atendente, tipoCol) {
  try {
    const refUrl = encodeURIComponent(lead_ref);
    const resp = String(atendente || '').trim();
    if (!resp) {   // sem responsável: o lead sai dos quadros por atendente
      await fetch(`${SB_URL}/rest/v1/kanban_cards?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, { method: 'DELETE', headers: H });
      return;
    }
    const rb = await fetch(`${SB_URL}/rest/v1/kanban_boards?conta_id=eq.${contaId}&atendente=eq.${encodeURIComponent(resp)}&select=id&limit=1`, { headers: H });
    if (!rb.ok) return;   // coluna atendente ainda não existe (setup-kanban3)
    const board = (await rb.json())[0];
    if (!board) return;   // atendente sem quadro: nada a fazer
    const rc = await fetch(`${SB_URL}/rest/v1/kanban_cols?board_id=eq.${board.id}&select=id,tipo`, { headers: H });
    if (!rc.ok) return;
    const cols = await rc.json();
    let alvo = cols.find((c) => c.tipo === tipoCol);
    if (!alvo) {
      const faltam = FUNIL.filter((f) => !cols.some((c) => c.tipo === f.tipo));
      if (faltam.length) {
        const rn = await fetch(`${SB_URL}/rest/v1/kanban_cols`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify(faltam.map((f) => ({ conta_id: contaId, board_id: board.id, nome: f.nome, tipo: f.tipo, ordem: FUNIL.findIndex((x) => x.tipo === f.tipo) }))),
        });
        if (rn.ok) alvo = (await rn.json()).find((c) => c.tipo === tipoCol);
      }
    }
    if (!alvo) return;
    // sai dos quadros de outros atendentes
    await fetch(`${SB_URL}/rest/v1/kanban_cards?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&board_id=neq.${board.id}`, { method: 'DELETE', headers: H });
    // move (ou cria) o card no quadro do responsável
    const rcard = await fetch(`${SB_URL}/rest/v1/kanban_cards?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}&board_id=eq.${board.id}&select=id&limit=1`, { headers: H });
    const card = rcard.ok ? (await rcard.json())[0] : null;
    if (card) await fetch(`${SB_URL}/rest/v1/kanban_cards?id=eq.${card.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ col_id: alvo.id, ordem: Date.now() }) });
    else await fetch(`${SB_URL}/rest/v1/kanban_cards`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ conta_id: contaId, board_id: board.id, col_id: alvo.id, lead_ref, ordem: Date.now() }) });
  } catch { /* kanban é acompanhamento; o dado principal já foi salvo */ }
}
