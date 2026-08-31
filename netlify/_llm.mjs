/**
 * Cliente cru da API da Claude (Anthropic) — sem SDK, fetch() direto, mesmo
 * padrão de todo o resto do projeto (Supabase/Evolution/Cal.com/Google).
 *
 * Env:
 *   ANTHROPIC_API_KEY — obrigatória (sem ela, configurada() retorna false)
 *   ANTHROPIC_MODEL   — opcional, default claude-sonnet-5 (trocar de modelo
 *                        é só mudar essa env, sem tocar em código)
 */
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const VERSAO = '2023-06-01';

export const configurada = () => !!API_KEY;

function mensagemErroClaude(d, status) {
  const msg = d && d.error && d.error.message;
  return 'Claude recusou (' + status + ')' + (msg ? ': ' + msg : '');
}

/* 1 chamada crua à API de Messages, com cache de prompt no bloco de sistema
   (ttl de 1h — leads respondem com minutos/horas de intervalo entre
   mensagens, a janela de 1h aproveita bem mais o cache do que os 5min
   padrão). `system` precisa ser determinístico (mesmo texto → mesmo hash de
   cache) — ver montarSystemPrompt em _agenteIa.mjs. */
export async function chamarClaude({ system, messages, tools, maxTokens }) {
  if (!configurada()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada.' };
  const body = {
    model: MODEL,
    max_tokens: maxTokens || 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages,
  };
  if (tools && tools.length) body.tools = tools;
  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': VERSAO },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: 'Erro de rede ao chamar a Claude: ' + (e?.message || e) };
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: mensagemErroClaude(d, r.status) };
  return { ok: true, resposta: d };
}

/* concatena todos os blocos de texto de uma resposta (ignora tool_use, que
   é tratado à parte pelo loop de quem chamou) */
export function textoDaResposta(resposta) {
  return (resposta.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/* as chamadas de ferramenta de uma resposta (presentes quando stop_reason === 'tool_use') */
export function chamadasDeFerramenta(resposta) {
  return (resposta.content || []).filter((b) => b.type === 'tool_use');
}
