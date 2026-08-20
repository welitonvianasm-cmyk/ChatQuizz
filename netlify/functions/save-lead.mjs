/**
 * Captura progressiva na tabela PRÓPRIA do funil: diag_instagram_leads
 * (criada pelo setup.sql — nenhuma tabela existente do banco é tocada).
 *
 * UPSERT atômico por lead_ref (on_conflict): cada etapa do funil reenvia
 * o estado completo e a linha evolui.
 *
 * Qualificador/nível de consciência NÃO são aceitos do corpo da requisição:
 * são sempre recalculados aqui no servidor a partir das respostas cruas
 * (b.respostas) e da config publicada — o navegador do lead não é uma fonte
 * confiável pra decidir se um disparo automático de WhatsApp deve sair.
 *
 * Usa a chave service_role — só como env no backend, nunca no front.
 * Não dá pra fazer isso com a anon + RLS write-only: no Postgres, tanto
 * UPDATE com WHERE quanto ON CONFLICT DO UPDATE passam pelas policies de
 * SELECT pra enxergar a linha-alvo; sem leitura, todo update pega 0 linhas.
 * O projeto Supabase é dedicado a este funil (só esta tabela), então o
 * raio de alcance da chave fica contido nele.
 *
 * Env:
 *   SUPABASE_DIAG_SERVICE — chave service_role do projeto dedicado.
 *   SUPABASE_DIAG_KEY — fallback (anon): 1º save entra, updates falham
 *     alto no log — melhor que perder o lead inteiro em silêncio.
 *   SUPABASE_DIAG_URL — URL do projeto dedicado.
 */
import { votar, interpolar, carregarConfigPublicada } from '../_quiz.mjs';
import { dispararMentoriaHub } from '../_conexoes.mjs';
import { resolverContaPorHost } from '../_tenant.mjs';

const SUPABASE_URL = (process.env.SUPABASE_DIAG_URL || 'https://aktktxizmpwckvxbdjzf.supabase.co').replace(/\/+$/, '');
const TABLE = 'diag_instagram_leads';

/* respostas cruas ({perguntaId: índice(s)}) -> pares legíveis, pro
   espelho no MentoriaHub (não faz sentido mandar índice numérico pra
   um CRM externo que não conhece a config do quiz) */
function respostasLegiveis(perguntas, respostas) {
  if (!Array.isArray(perguntas) || !respostas) return [];
  return perguntas.map((p) => {
    const r = respostas[p.id];
    if (r === undefined || r === null) return null;
    const idxs = Array.isArray(r) ? r : [r];
    const textos = idxs.map((i) => (p.opts && p.opts[i] && p.opts[i].t) || '').filter(Boolean);
    return textos.length ? { pergunta: p.q, resposta: textos.join(', ') } : null;
  }).filter(Boolean);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const KEY = process.env.SUPABASE_DIAG_SERVICE || process.env.SUPABASE_DIAG_KEY;
    if (!KEY) return json({ error: 'SUPABASE_DIAG_SERVICE not configured' }, 500);
    const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

    const contaId = await resolverContaPorHost(req);
    if (!contaId) return json({ error: 'Conta não encontrada para este domínio' }, 404);

    const b = await req.json();
    if (!b.lead_ref || !b.nome) return json({ error: 'Missing lead_ref/nome' }, 400);

    const digits = String(b.whatsapp || '').replace(/\D/g, '');
    // o front já manda ddi+número (E.164 sem '+'); só prefixa '+' — não força 55 (quebraria estrangeiro)
    const e164 = digits ? `+${digits}` : '';
    const txt = (v, max = 300) => String(v ?? '').slice(0, max);
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

    const respostas = (b.respostas && typeof b.respostas === 'object') ? b.respostas : null;

    const row = {
      conta_id: contaId,
      lead_ref: txt(b.lead_ref, 60),
      status: txt(b.status || 'parcial', 20),
      nome: txt(b.nome, 120),
      email: txt(b.email, 200).toLowerCase(),
      whatsapp: e164,
      uf: txt(b.uf, 4),
      nicho: txt(b.nicho, 60),
      nicho_detectado: txt(b.nicho_detectado, 60),
      seguidores: txt(b.seguidores, 40),
      dificuldade: txt(b.dificuldade, 300),
      renda: txt(b.faturamento, 60),
      lead_score: num(b.score),
      qualificado: typeof b.qualificado === 'boolean' ? b.qualificado : null,
      call_track: txt(b.call_track, 12),
      vendedor: txt(b.vendedor, 60),
      agendado: b.agendado === true,
      agendamento_em: b.agendamento_em || null,
      booking_uid: txt(b.booking_uid, 80),
      video_url: txt(b.video_url, 300),
      utm_source: txt(b.utm_source, 200),
      utm_medium: txt(b.utm_medium, 200),
      utm_campaign: txt(b.utm_campaign, 200),
      utm_content: txt(b.utm_content, 200),
      utm_term: txt(b.utm_term, 200),
      fbclid: txt(b.fbclid, 255),
      referrer: txt(b.referrer, 300),
      ...(respostas ? { respostas_json: txt(JSON.stringify(respostas), 6000) } : {}),
    };

    /* Qualificação + roteamento — só recalcula (e só dispara ação
       automática) quando o quiz foi realmente concluído. */
    let disparoWhats = null;
    let docQuiz = null;
    if (row.status === 'completo' && respostas) {
      const { doc } = await carregarConfigPublicada(SUPABASE_URL, H, contaId);
      docQuiz = doc;
      const qualificador = votar(doc.perguntas, respostas, 'qualificador');
      const nivel = votar(doc.perguntas, respostas, 'nivel');
      row.qualificador = txt(qualificador, 40);
      row.nivel_consciencia = txt(nivel, 40);
      const rota = qualificador && doc.roteamento ? doc.roteamento[qualificador] : null;
      if (rota) {
        row.roteamento_tipo = txt(rota.tipo, 20);
        if (rota.tipo === 'whatsapp' && rota.auto && e164 && rota.mensagem) {
          row.roteamento_disparado_em = new Date().toISOString();
          disparoWhats = {
            telefone: digits,
            mensagem: interpolar(rota.mensagem, { nome: (row.nome || '').split(' ')[0] }),
          };
        }
      }
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=conta_id,lead_ref`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Supabase save error:', res.status, errText.slice(0, 300));
      return json({ error: 'DB save failed' }, 500);
    }

    /* Fila de WhatsApp automático — reaproveita o cron/disparos que já
       existe (idempotente pela chave_unica; nunca duplica pro mesmo lead). */
    if (disparoWhats) {
      await fetch(`${SUPABASE_URL}/rest/v1/disparos`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({
          conta_id: contaId, telefone: disparoWhats.telefone, lead_ref: row.lead_ref, nome: row.nome,
          mensagem: disparoWhats.mensagem,
          enviar_em: new Date().toISOString(), status: 'pendente', origem: 'roteamento_quiz',
          chave_unica: 'roteamento|' + row.lead_ref,
        }),
      }).catch((e) => console.warn('[disparo roteamento] falhou (seguindo normal):', e.message));
    }

    /* Espelho global no MentoriaHub (se conectado) — independe de
       qualificador/roteamento, dispara pra TODO lead completo. */
    if (row.status === 'completo' && respostas) {
      dispararMentoriaHub(contaId, 'lead_qualificado', {
        nome: row.nome, email: row.email, telefone: row.whatsapp, estado: row.uf,
        canalCaptacao: row.utm_source ? `quizzhub-${row.utm_source}` : 'quizzhub',
        campanha: row.utm_campaign, conteudoEspecifico: row.utm_content, tags: ['quizzhub'],
        chatquizzLeadRef: row.lead_ref,
        qualificadorQuiz: row.qualificador, nivelConscienciaQuiz: row.nivel_consciencia,
        scoreQuiz: row.lead_score, rendaQuiz: row.renda,
        dadosExtras: {
          respostas: respostasLegiveis(docQuiz && docQuiz.perguntas, respostas),
          utm_medium: row.utm_medium, utm_term: row.utm_term, fbclid: row.fbclid, referrer: row.referrer,
        },
      });
    }
    /* Agendamento confirmado pelo embed do Cal.com dentro do próprio quiz —
       reflete na Agenda/Reuniões do MentoriaHub (mesmo chatquizzLeadRef do
       evento acima, pra correlacionar sem duplicar). */
    if (row.status === 'agendado' && row.agendamento_em) {
      dispararMentoriaHub(contaId, 'agendamento_confirmado', {
        chatquizzLeadRef: row.lead_ref, agendamentoEm: row.agendamento_em,
        linkReuniao: row.video_url, bookingUid: row.booking_uid,
      });
    }

    return json({ ok: true });
  } catch (err) {
    console.error('save-lead error:', err);
    return json({ error: err.message }, 500);
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export const config = { path: '/api/save-lead' };
