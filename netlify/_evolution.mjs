/**
 * Cliente Evolution API por conta — cada conta_id pode conectar uma ou mais
 * instâncias/números (tabela wa_instancias), em vez do antigo padrão de
 * EVOLUTION_INSTANCE única e global compartilhada por todo mundo.
 *
 * Env:
 *   EVOLUTION_URL — URL do servidor Evolution (o servidor em si é compartilhado
 *                   por todas as contas/instâncias; cada instância é isolada lá dentro)
 *   EVOLUTION_KEY — apikey global da Evolution (autentica qualquer instância nesse servidor)
 *   WA_WEBHOOK_SECRET, URL — usados pra registrar o webhook de cada instância nova
 */
const SB_URL = (process.env.SUPABASE_DIAG_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_DIAG_SERVICE || '';
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const EV_URL = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
const EV_KEY = process.env.EVOLUTION_KEY || '';
const SITE_URL = (process.env.URL || '').replace(/\/+$/, '');

export const configurada = () => !!(EV_URL && EV_KEY);
const ev = (path, opts = {}) => fetch(`${EV_URL}${path}`, { ...opts, headers: { apikey: EV_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

export const soDigitos = (t) => String(t || '').replace(/\D/g, '');
/* normaliza número BR pro formato canônico 55+DDD+9 dígitos — o WhatsApp às
   vezes reporta o mesmo contato com ou sem o 9º dígito do celular, o que sem
   isso vira dois "telefone" diferentes (conversa duplicada na lista). Mesma
   função em wa-webhook.mjs/lead-admin.mjs/webhook-pagamento.mjs. */
export function normalizarTelefoneBR(raw) {
  const d = soDigitos(raw);
  if (!d) return '';
  let resto;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) resto = d.slice(2);
  else if (d.length === 10 || d.length === 11) resto = d;
  else return d;
  const ddd = resto.slice(0, 2);
  let numero = resto.slice(2);
  if (numero.length === 8) numero = '9' + numero;
  return '55' + ddd + numero;
}
/* extrai o texto de erro real da Evolution — o formato varia (string, array de
   strings, ou objeto aninhado em response.message) */
function textoDe(m) {
  if (m == null) return null;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((x) => textoDe(x) || JSON.stringify(x)).join('; ');
  if (typeof m === 'object') return textoDe(m.message) || JSON.stringify(m);
  return String(m);
}
export function mensagemErroEvolution(d, status) {
  const detalhe = textoDe(d && (d.response?.message ?? d.message ?? d.error));
  return 'Evolution recusou o envio (' + status + ')' + (detalhe ? ': ' + detalhe : '');
}

/* ==================== instâncias por conta ==================== */

export async function listarInstancias(contaId) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_instancias?conta_id=eq.${contaId}&select=id,nome_instancia,rotulo,numero,padrao,estado,criado_em&order=criado_em.asc`, { headers: H });
  return r.ok ? await r.json() : [];
}

export async function obterInstancia(contaId, id) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_instancias?conta_id=eq.${contaId}&id=eq.${Number(id) || 0}&limit=1`, { headers: H });
  if (!r.ok) return null;
  return (await r.json())[0] || null;
}

async function obterInstanciaPorNome(nomeInstancia) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_instancias?nome_instancia=eq.${encodeURIComponent(nomeInstancia)}&limit=1`, { headers: H });
  if (!r.ok) return null;
  return (await r.json())[0] || null;
}

/* conta_id dono de uma instância pelo nome — usado pelo wa-webhook.mjs pra
   resolver o tenant a partir do campo "instance" do payload da Evolution */
export async function obterContaPorInstancia(nomeInstancia) {
  const inst = await obterInstanciaPorNome(nomeInstancia);
  return inst ? inst.conta_id : null;
}

export async function obterInstanciaPadrao(contaId) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_instancias?conta_id=eq.${contaId}&padrao=eq.true&limit=1`, { headers: H });
  if (r.ok) { const rows = await r.json(); if (rows[0]) return rows[0]; }
  // sem padrão marcado (não devia acontecer, mas não trava): cai na primeira
  const r2 = await fetch(`${SB_URL}/rest/v1/wa_instancias?conta_id=eq.${contaId}&order=criado_em.asc&limit=1`, { headers: H });
  if (r2.ok) { const rows = await r2.json(); return rows[0] || null; }
  return null;
}

/* garante que a resposta sai pelo MESMO número que o lead já está
   conversando — evita responder de um número diferente numa conta com
   vários conectados. Sem histórico ainda (conversa nova): cai no padrão. */
export async function obterInstanciaDaConversa(contaId, telefone) {
  const tel = normalizarTelefoneBR(telefone);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/wa_mensagens?conta_id=eq.${contaId}&telefone=eq.${tel}&instancia=neq.&select=instancia&order=criado_em.desc&limit=1`, { headers: H });
    if (r.ok) {
      const rows = await r.json();
      if (rows[0] && rows[0].instancia) {
        const inst = await obterInstanciaPorNome(rows[0].instancia);
        if (inst && inst.conta_id === contaId) return inst;
      }
    }
  } catch { /* cai no padrão */ }
  return obterInstanciaPadrao(contaId);
}

/* nome único da instância na Evolution: c{contaId}-{slug-do-rotulo}-{sufixo} */
function gerarNomeInstancia(contaId, rotulo) {
  const slug = String(rotulo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 20) || 'wa';
  const sufixo = Math.random().toString(36).slice(2, 7);
  return `c${contaId}-${slug}-${sufixo}`;
}

export async function criarInstancia(contaId, rotulo) {
  if (!configurada()) return { ok: false, error: 'A Evolution API ainda não foi configurada.' };
  const nomeInstancia = gerarNomeInstancia(contaId, rotulo);
  try {
    await ev('/instance/create', { method: 'POST', body: JSON.stringify({ instanceName: nomeInstancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' }) });
  } catch (e) {
    return { ok: false, error: 'Erro ao criar a instância na Evolution: ' + (e?.message || e) };
  }
  const segredo = process.env.WA_WEBHOOK_SECRET || '';
  if (segredo && SITE_URL) {
    try {
      await ev(`/webhook/set/${nomeInstancia}`, {
        method: 'POST',
        body: JSON.stringify({ webhook: { enabled: true, url: `${SITE_URL}/api/wa-webhook?t=${segredo}`, events: ['MESSAGES_UPSERT'], base64: false, byEvents: false } }),
      });
    } catch { /* reconfigura no próximo QR/reconexão */ }
  }
  const existentes = await listarInstancias(contaId);
  const padrao = existentes.length === 0;   // primeiro número da conta já nasce padrão
  const r = await fetch(`${SB_URL}/rest/v1/wa_instancias`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ conta_id: contaId, nome_instancia: nomeInstancia, rotulo: String(rotulo || '').trim().slice(0, 60), padrao }),
  });
  if (!r.ok) return { ok: false, error: 'A instância foi criada na Evolution, mas falhou ao salvar no painel — tente remover e criar de novo.' };
  const linha = (await r.json())[0];
  return { ok: true, instancia: linha };
}

export async function qrInstancia(nomeInstancia) {
  if (!configurada()) return { ok: false, error: 'A Evolution API ainda não foi configurada.' };
  const r = await ev(`/instance/connect/${nomeInstancia}`);
  const d = await r.json().catch(() => ({}));
  const qr = (d && (d.base64 || (d.qrcode && d.qrcode.base64))) || '';
  if (!qr) return { ok: false, error: 'QR indisponível agora (a instância pode já estar conectada).' };
  return { ok: true, qr };
}

export async function statusInstancia(nomeInstancia) {
  if (!configurada()) return 'nao_configurada';
  try {
    const r = await ev(`/instance/connectionState/${nomeInstancia}`);
    if (r.ok) { const d = await r.json(); return (d.instance && d.instance.state) === 'open' ? 'conectada' : 'desconectada'; }
  } catch { /* erro de rede/servidor */ }
  return 'erro';
}

export async function removerInstancia(contaId, id) {
  const inst = await obterInstancia(contaId, id);
  if (!inst) return { ok: false, error: 'Instância não encontrada.' };
  if (configurada()) {
    try { await ev(`/instance/logout/${inst.nome_instancia}`, { method: 'DELETE' }); } catch { /* melhor-esforço */ }
    try { await ev(`/instance/delete/${inst.nome_instancia}`, { method: 'DELETE' }); } catch { /* melhor-esforço */ }
  }
  await fetch(`${SB_URL}/rest/v1/wa_instancias?id=eq.${Number(id)}&conta_id=eq.${contaId}`, { method: 'DELETE', headers: H });
  if (inst.padrao) {
    // promove a próxima mais antiga, se sobrar alguma — nunca deixa a conta sem padrão à toa
    const restantes = await listarInstancias(contaId);
    if (restantes[0]) {
      await fetch(`${SB_URL}/rest/v1/wa_instancias?id=eq.${restantes[0].id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ padrao: true }),
      });
    }
  }
  return { ok: true };
}

export async function definirPadrao(contaId, id) {
  const inst = await obterInstancia(contaId, id);
  if (!inst) return { ok: false, error: 'Instância não encontrada.' };
  await fetch(`${SB_URL}/rest/v1/wa_instancias?conta_id=eq.${contaId}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ padrao: false }),
  });
  await fetch(`${SB_URL}/rest/v1/wa_instancias?id=eq.${Number(id)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ padrao: true }),
  });
  return { ok: true };
}

/* atualiza estado/número em cache local (chamado depois de checar status na Evolution) */
export async function atualizarEstadoLocal(id, estado, numero) {
  const patch = { estado };
  if (numero) patch.numero = numero;
  await fetch(`${SB_URL}/rest/v1/wa_instancias?id=eq.${Number(id)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
}

/* ==================== mídia recebida ==================== */

/* baixa (e decripta) uma mídia recebida — o WhatsApp guarda mídia
   criptografada ponta-a-ponta no CDN da Meta, então não dá pra simplesmente
   buscar a URL que vem no payload do webhook; só a própria Evolution
   consegue decifrar (ela já tem as chaves da sessão). Endpoint/corpo
   conferidos direto no código-fonte real da Evolution API: POST
   /chat/getBase64FromMediaMessage/:instance, corpo {message: <objeto bruto
   da mensagem, o mesmo item do array "data" do webhook>}.
   NÃO VERIFICADO na fonte: o nome exato do campo de resposta com o base64
   — o controller mostra a chamada, mas o formato de resposta não estava
   visível. Tenta os nomes mais prováveis (base64/media/buffer); se a
   Evolution usar outro, ajustar aqui depois de 1 teste real. */
export async function baixarMidia(nomeInstancia, mensagemBruta) {
  if (!configurada()) return { ok: false, error: 'WhatsApp não conectado (Evolution não configurada).' };
  const r = await ev(`/chat/getBase64FromMediaMessage/${nomeInstancia}`, {
    method: 'POST', body: JSON.stringify({ message: mensagemBruta }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: mensagemErroEvolution(d, r.status) };
  const base64 = d.base64 || d.media || d.buffer || '';
  if (!base64) return { ok: false, error: 'Evolution não devolveu o áudio (formato de resposta inesperado).' };
  return { ok: true, base64, mimetype: d.mimetype || d.mimeType || '' };
}

/* ==================== envio ==================== */

/* envia texto por UMA instância específica — só a chamada crua à Evolution,
   sem gravar histórico (isso é responsabilidade de quem chama, que sabe o
   contexto: lead_ref, quem mandou, etc. — ver enviarWhats em whatsapp.mjs) */
export async function enviarTexto(nomeInstancia, telefone, texto) {
  const tel = normalizarTelefoneBR(telefone);
  if (!tel || !texto) return { ok: false, error: 'telefone/mensagem vazios' };
  if (!configurada()) return { ok: false, error: 'WhatsApp não conectado (Evolution não configurada).' };
  const r = await ev(`/message/sendText/${nomeInstancia}`, { method: 'POST', body: JSON.stringify({ number: tel, text: texto }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: mensagemErroEvolution(d, r.status) };
  const wa_id = (d && d.key && d.key.id) || '';
  return { ok: true, wa_id };
}

/* envia mídia (imagem/documento) por UMA instância específica. `media` é a
   URL do arquivo (link assinado do Supabase Storage, curto prazo) — a
   própria Evolution busca o arquivo por trás, não precisamos mandar bytes.
   Endpoint/corpo conferidos direto no código-fonte real da Evolution API
   (mesma prática já usada pro sendText nesse projeto): POST
   /message/sendMedia/:instance, {number, mediatype, mimetype, caption?,
   fileName?, media}. */
export async function enviarMidia(nomeInstancia, telefone, mediaUrl, mimetype, nomeArquivo, legenda) {
  const tel = normalizarTelefoneBR(telefone);
  if (!tel || !mediaUrl) return { ok: false, error: 'telefone/arquivo vazios' };
  if (!configurada()) return { ok: false, error: 'WhatsApp não conectado (Evolution não configurada).' };
  const mediatype = String(mimetype || '').startsWith('image/') ? 'image' : 'document';
  const r = await ev(`/message/sendMedia/${nomeInstancia}`, {
    method: 'POST',
    body: JSON.stringify({ number: tel, mediatype, mimetype, media: mediaUrl, fileName: nomeArquivo || undefined, caption: legenda || undefined }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: mensagemErroEvolution(d, r.status) };
  const wa_id = (d && d.key && d.key.id) || '';
  return { ok: true, wa_id };
}
