/* ====================================================================
   GOOGLE AGENDA — espelho de eventos, por conta. NÃO é uma "vitrine" de
   agendamento (isso continua sendo o Cal.com, que já tem produto pronto
   pra isso); aqui só refletimos uma reunião JÁ confirmada (via Cal.com
   ou marcada manualmente pelo painel) como um evento no Google Agenda
   de quem conectou, e aproveitamos pra gerar uma sala do Google Meet
   automática (event.hangoutLink) — sem precisar decifrar o formato de
   resposta do Cal.com, que varia conforme como o tipo de evento de lá
   está configurado.

   Sem servidor de longa duração aqui (Netlify Functions = processo novo
   a cada chamada): o refresh de access_token é feito NA MÃO, checando a
   expiração antes de cada uso e salvando o token novo de volta em
   funnel_config antes de seguir — não dá pra confiar num listener
   "vivo" tipo o que um servidor contínuo (Node/NestJS) usaria.

   Tudo aqui é melhor-esforço: qualquer falha (token revogado, rede,
   conta sem conexão) só loga e devolve null/undefined — nunca derruba
   quem chamou (mesmo espírito do dispararMentoriaHub/enviarWhats).
   ==================================================================== */
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { lerConexaoGoogleAgenda, salvarConexaoGoogleAgenda } from './_conexoes.mjs';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const TZ = 'America/Sao_Paulo';

export function criarOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/* cliente autenticado da conta, com o access_token já renovado se
   necessário (persiste o token novo antes de devolver). null se a
   conta nunca conectou o Google (refresh_token ausente). */
export async function obterClienteGoogle(contaId) {
  const conexao = await lerConexaoGoogleAgenda(contaId);
  if (!conexao.refreshToken) return null;

  const client = criarOAuthClient();
  client.setCredentials({
    refresh_token: conexao.refreshToken,
    access_token: conexao.accessToken || undefined,
    expiry_date: conexao.tokenExpiry ? new Date(conexao.tokenExpiry).getTime() : 0,
  });

  const prestesAVencer = !conexao.tokenExpiry || new Date(conexao.tokenExpiry).getTime() < Date.now() + 60000;
  if (prestesAVencer) {
    const { credentials } = await client.refreshAccessTokenAsync();
    client.setCredentials(credentials);
    await salvarConexaoGoogleAgenda(contaId, {
      ...conexao,
      accessToken: credentials.access_token,
      tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
    });
  }
  return client;
}

/* cria ou atualiza o evento-espelho. Sem googleEventId → INSERT, pedindo
   uma sala do Meet junto (conferenceDataVersion:1 + createRequest);
   devolve {id, meetLink}. Com googleEventId → UPDATE, sem pedir sala
   nova (o link do Meet continua o mesmo mesmo remarcando o horário).
   Sem attendee recebendo convite por e-mail (sendUpdates não é setado,
   fica no padrão "não notifica" — o QuizzHub já avisa o lead por fora). */
export async function sincronizarEventoGoogle(contaId, { googleEventId, titulo, inicioISO, fimISO, participanteNome, participanteEmail }) {
  try {
    const client = await obterClienteGoogle(contaId);
    if (!client) return null;
    const conexao = await lerConexaoGoogleAgenda(contaId);
    const calendarId = conexao.calendarId || 'primary';
    const calendar = google.calendar({ version: 'v3', auth: client });

    const eventBody = {
      summary: titulo,
      start: { dateTime: inicioISO, timeZone: TZ },
      end: { dateTime: fimISO, timeZone: TZ },
      ...(participanteEmail ? { attendees: [{ email: participanteEmail, displayName: participanteNome || undefined }] } : {}),
    };

    if (googleEventId) {
      const { data } = await calendar.events.update({ calendarId, eventId: googleEventId, requestBody: eventBody });
      return { id: data.id, meetLink: data.hangoutLink || '' };
    }

    eventBody.conferenceData = {
      createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
    const { data } = await calendar.events.insert({ calendarId, conferenceDataVersion: 1, requestBody: eventBody });
    return { id: data.id, meetLink: data.hangoutLink || '' };
  } catch (e) {
    console.warn('[google-agenda] sincronizarEvento falhou (seguindo normal):', e?.message || e);
    return null;
  }
}

/* remove o evento-espelho. Idempotente: "evento já não existe" não é
   tratado como erro de verdade, só segue (mesmo comportamento pro caso
   de cancelar 2x ou de alguém já ter apagado manualmente no Google). */
export async function removerEventoGoogle(contaId, googleEventId) {
  if (!googleEventId) return;
  try {
    const client = await obterClienteGoogle(contaId);
    if (!client) return;
    const conexao = await lerConexaoGoogleAgenda(contaId);
    const calendarId = conexao.calendarId || 'primary';
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId, eventId: googleEventId });
  } catch (e) {
    console.warn('[google-agenda] removerEvento falhou (seguindo normal):', e?.message || e);
  }
}

/* lista os calendários da conta Google conectada, pra administradora
   escolher em qual gravar (painel → Conexões → Google Agenda). */
export async function listarCalendariosGoogle(contaId) {
  const client = await obterClienteGoogle(contaId);
  if (!client) return [];
  const calendar = google.calendar({ version: 'v3', auth: client });
  const { data } = await calendar.calendarList.list();
  return (data.items || []).map((c) => ({ id: c.id, nome: c.summary || c.id, principal: !!c.primary }));
}
