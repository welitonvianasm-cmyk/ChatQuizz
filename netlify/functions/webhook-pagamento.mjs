/**
 * WEBHOOK DE PAGAMENTO — recebe a confirmação de uma venda vinda de uma
 * plataforma de pagamento (via MAKE, que normaliza o checkout de origem)
 * e converte o lead sozinho, sem ação manual da equipe.
 *
 *   POST /api/webhook-pagamento?conta=<contaId>&segredo=<token>
 *   Corpo: { email, telefone, nome, produto, valor, forma_pagamento, endereco }
 *
 * O segredo é gerado pelo próprio painel (Conexões → Pagamentos), por
 * conta — ver netlify/_conexoes.mjs (lerConexaoWebhookPagamento).
 *
 * Acha o lead por telefone → e-mail → nome; não achando nenhum, CRIA um
 * lead novo (origem:'webhook-pagamento') pra nunca perder a venda.
 * Resolve o nome do produto contra o catálogo (produto_aliases faz o
 * "de-para"; bate exato com o catálogo sem alias ainda → vincula sozinho
 * pra da próxima vez já resolver direto). Converte o lead só na 1ª venda;
 * cliente recorrente entra em venda_json.compras sem perder o histórico.
 *
 * Diferente dos outros webhooks do projeto (espelhos, fire-and-forget):
 * este É o propósito da chamada, então erros reais retornam status de
 * erro de verdade — o MAKE precisa saber se falhou pra poder reenviar.
 */
import { lerConexaoWebhookPagamento, dispararMentoriaHub } from '../_conexoes.mjs';
import { moverNoKanban } from '../_kanban.mjs';

const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const COLS_LEAD = 'lead_ref,nome,whatsapp,email,atendente,resultado,venda_json,equipe_json';
const fmtBRL = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SB_URL || !SB_KEY) return json({ ok: false, error: 'Supabase not configured' }, 500);

  try {
    const url = new URL(req.url);
    const contaId = Number(url.searchParams.get('conta'));
    const segredoRecebido = url.searchParams.get('segredo') || '';
    if (!Number.isInteger(contaId) || contaId <= 0) return json({ ok: false, error: 'Parâmetro "conta" inválido.' }, 400);

    const conexao = await lerConexaoWebhookPagamento(contaId);
    if (!conexao.segredo || !safeEqual(segredoRecebido, conexao.segredo)) return json({ ok: false, error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    const telefone = String(body.telefone || '').replace(/\D/g, '');
    const nome = String(body.nome || '').trim().slice(0, 160);
    const produtoRaw = String(body.produto || '').trim().slice(0, 120);
    const valor = Math.max(0, Number(body.valor) || 0);
    const formaPagamento = String(body.forma_pagamento || '').trim().slice(0, 40);
    const endereco = String(body.endereco || '').trim().slice(0, 400);
    if (!email && !telefone && !nome) return json({ ok: false, error: 'Informe ao menos email, telefone ou nome.' }, 400);
    if (!produtoRaw) return json({ ok: false, error: 'Informe o produto.' }, 400);

    /* ---------- acha o lead: telefone → e-mail → nome ---------- */
    let lead = null;
    if (telefone) {
      const fim = telefone.slice(-10);
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&whatsapp=ilike.*${fim}&select=${COLS_LEAD}&limit=1`, { headers: H });
      if (r.ok) lead = (await r.json())[0] || null;
    }
    if (!lead && email) {
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&email=ilike.${encodeURIComponent(email)}&select=${COLS_LEAD}&limit=1`, { headers: H });
      if (r.ok) lead = (await r.json())[0] || null;
    }
    if (!lead && nome) {
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&nome=ilike.${encodeURIComponent(nome)}&select=${COLS_LEAD}&limit=1`, { headers: H });
      if (r.ok) lead = (await r.json())[0] || null;
    }

    /* ---------- não achou ninguém: cria o lead na hora, nunca perde a venda ---------- */
    let criado = false;
    if (!lead) {
      criado = true;
      const lead_ref = 'webhook_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      const agora = new Date().toISOString();
      const eq0 = { obs: '', campos: [], historico: [{ t: agora, quem: 'Webhook Pagamento', txt: 'Lead criado automaticamente por um pagamento confirmado (' + produtoRaw + ')' }] };
      const novo = {
        conta_id: contaId, lead_ref, nome: nome || 'Cliente sem nome',
        whatsapp: telefone, email, status: 'completo', origem: 'webhook-pagamento',
        equipe_json: JSON.stringify(eq0), created_at: agora, updated_at: agora,
      };
      const r = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(novo),
      });
      if (!r.ok) {
        console.error('webhook-pagamento criar lead:', await r.text().catch(() => ''));
        return json({ ok: false, error: 'Erro ao criar o lead.' }, 500);
      }
      lead = (await r.json())[0] || novo;
    }

    /* ---------- resolve o produto: alias conhecido → catálogo exato (vincula sozinho) → nome cru ---------- */
    let produtoFinal = produtoRaw;
    let vinculado = false;
    try {
      const ra = await fetch(`${SB_URL}/rest/v1/produto_aliases?conta_id=eq.${contaId}&nome_externo=eq.${encodeURIComponent(produtoRaw)}&select=produto_id&limit=1`, { headers: H });
      if (ra.ok) {
        const aliasRow = (await ra.json())[0];
        if (aliasRow) {
          const rp = await fetch(`${SB_URL}/rest/v1/produtos?id=eq.${aliasRow.produto_id}&select=nome&limit=1`, { headers: H });
          if (rp.ok) { const p = (await rp.json())[0]; if (p) { produtoFinal = p.nome; vinculado = true; } }
        }
      }
      if (!vinculado) {
        const rc = await fetch(`${SB_URL}/rest/v1/produtos?conta_id=eq.${contaId}&nome=ilike.${encodeURIComponent(produtoRaw)}&select=id,nome&limit=1`, { headers: H });
        if (rc.ok) {
          const p = (await rc.json())[0];
          if (p) {
            produtoFinal = p.nome; vinculado = true;
            await fetch(`${SB_URL}/rest/v1/produto_aliases?on_conflict=conta_id,nome_externo`, {
              method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({ conta_id: contaId, nome_externo: produtoRaw, produto_id: p.id }),
            });
          }
        }
      }
    } catch { /* setup-pagamento-webhook.sql ainda não rodou — segue com o nome cru */ }

    /* ---------- histórico de compras (cliente recorrente não perde a venda anterior) ---------- */
    let venda = {};
    try { const p = JSON.parse(lead.venda_json || ''); if (p && typeof p === 'object') venda = p; } catch { /* vazio */ }
    venda.compras = Array.isArray(venda.compras) ? venda.compras : [];
    const hoje = new Date().toISOString().slice(0, 10);
    const duplicado = venda.compras.some((cp) => cp && cp.produto === produtoFinal && Number(cp.valor) === valor && String(cp.data || '').slice(0, 10) === hoje);
    if (!duplicado) {
      venda.compras.push({ produto: produtoFinal, valor, pagamentos: formaPagamento ? [{ forma: formaPagamento, valor }] : [], data: new Date().toISOString() });
      venda.produto = produtoFinal;
      venda.valor = valor;
      venda.pagamentos = formaPagamento ? [{ forma: formaPagamento, valor }] : (venda.pagamentos || []);
      if (endereco && !venda.endereco) venda.endereco = endereco;
    }

    /* ---------- converte (só na 1ª venda) + histórico automático ---------- */
    let eq = { obs: '', campos: [], historico: [] };
    try { const p = JSON.parse(lead.equipe_json || ''); if (p && typeof p === 'object') eq = { obs: p.obs || '', campos: Array.isArray(p.campos) ? p.campos : [], historico: Array.isArray(p.historico) ? p.historico : [] }; } catch { /* vazio */ }
    const hist = (txt) => { eq.historico.unshift({ t: new Date().toISOString(), quem: 'Webhook Pagamento', txt }); eq.historico = eq.historico.slice(0, 60); };

    const jaConvertido = lead.resultado === 'convertido';
    const atendente = (lead.atendente || '').trim();
    const patch = { updated_at: new Date().toISOString() };
    if (!jaConvertido) {
      patch.resultado = 'convertido';
      patch.resultado_em = new Date().toISOString();
      patch.resultado_por = atendente || 'Webhook Pagamento';
      patch.etapa = '';
    }
    if (!duplicado) {
      patch.venda_json = JSON.stringify(venda);
      hist('Pagamento confirmado' + (jaConvertido ? ' (cliente recorrente)' : '') + ': ' + produtoFinal + ' — ' + fmtBRL(valor));
      patch.equipe_json = JSON.stringify(eq);
    }

    if (Object.keys(patch).length > 1) {
      const refUrl = encodeURIComponent(lead.lead_ref);
      const rp = await fetch(`${SB_URL}/rest/v1/diag_instagram_leads?conta_id=eq.${contaId}&lead_ref=eq.${refUrl}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!rp.ok) {
        console.error('webhook-pagamento patch:', await rp.text().catch(() => ''));
        return json({ ok: false, error: 'Erro ao salvar a venda.' }, 500);
      }
    }

    if (!jaConvertido) await moverNoKanban(contaId, lead.lead_ref, atendente, 'convertido');

    /* ---------- notifica o atendente responsável (se tiver um) ---------- */
    if (!duplicado && atendente) {
      try {
        await fetch(`${SB_URL}/rest/v1/alertas`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({
            conta_id: contaId, lead_ref: lead.lead_ref, lead_nome: lead.nome || nome || '',
            atendente, tipo: 'pagamento',
            descricao: 'Pagamento confirmado: ' + produtoFinal + ' — ' + fmtBRL(valor) + ' (' + (lead.nome || nome || 'cliente') + ')',
            data_hora: new Date().toISOString(), status: 'pendente',
          }),
        });
      } catch { /* alerta é melhor-esforço; a venda já foi salva */ }
    }

    /* espelha a conversão pro MentoriaHub conectado (se tiver) — só o
       evento 'conversao', fire-and-forget; lá cai em Alunos → Via Webhook
       pra aprovação, sem depender do Lead nem do módulo Vendas de lá */
    if (!duplicado) {
      dispararMentoriaHub(contaId, 'conversao', {
        nome: lead.nome || nome || '', email: lead.email || email || '', telefone: lead.whatsapp || telefone || '',
        produto: produtoFinal, valor, formaPagamento, chatquizzLeadRef: lead.lead_ref,
      });
    }

    return json({ ok: true, lead_ref: lead.lead_ref, criado, convertido_agora: !jaConvertido, produto_vinculado: vinculado, duplicado });
  } catch (e) {
    console.error('webhook-pagamento:', e?.message || e);
    return json({ ok: false, error: 'error' }, 500);
  }
};

/* comparação de tempo ~constante (evita vazar tamanho/prefixo do segredo por timing) */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}

export const config = { path: '/api/webhook-pagamento' };
