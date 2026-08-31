/**
 * Transcrição de áudio (Whisper da OpenAI) — usado pelo Agente IA (Fase 4)
 * pra entender e responder mensagens de voz do WhatsApp.
 *
 * Env: OPENAI_API_KEY (obrigatória; sem ela, configurada() retorna false).
 * Deliberadamente uma API separada da Claude (Anthropic não transcreve
 * áudio) — decisão já confirmada com o usuário.
 */
const API_KEY = process.env.OPENAI_API_KEY || '';
const API_URL = 'https://api.openai.com/v1/audio/transcriptions';

export const configurada = () => !!API_KEY;

/* base64Audio: bytes crus do áudio (ex.: vindos de baixarMidia em
   _evolution.mjs) em base64, sem prefixo data:. mimetype vem do próprio
   payload da Evolution (ex.: 'audio/ogg; codecs=opus') — a extensão do
   nome do arquivo importa mais pra API da OpenAI do que o mimetype em si,
   então normalizamos pra .ogg quando não reconhecemos o formato. */
export async function transcrever(base64Audio, mimetype) {
  if (!configurada()) return { ok: false, error: 'OPENAI_API_KEY não configurada.' };
  if (!base64Audio) return { ok: false, error: 'áudio vazio' };
  let bytes;
  try { bytes = Buffer.from(base64Audio, 'base64'); } catch { return { ok: false, error: 'áudio inválido' }; }
  if (!bytes.length) return { ok: false, error: 'áudio inválido' };

  const ext = String(mimetype || '').includes('mp4') ? 'mp4'
    : String(mimetype || '').includes('mpeg') ? 'mp3'
    : String(mimetype || '').includes('wav') ? 'wav'
    : 'ogg';

  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  form.append('file', new Blob([bytes], { type: mimetype || 'audio/ogg' }), `audio.${ext}`);

  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form,
    });
  } catch (e) {
    return { ok: false, error: 'Erro de rede ao transcrever: ' + (e?.message || e) };
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d && d.error && d.error.message;
    return { ok: false, error: 'Whisper recusou (' + r.status + ')' + (msg ? ': ' + msg : '') };
  }
  const texto = String(d.text || '').trim();
  if (!texto) return { ok: false, error: 'Transcrição veio vazia.' };
  return { ok: true, texto };
}
