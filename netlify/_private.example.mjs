/* ====================================================================
   MODELO de _private.mjs (o arquivo real fica FORA do repositório).
   Copie para  netlify/functions/_private.mjs  e preencha com o seu
   conteúdo. O Netlify empacota o _private.mjs via import no deploy.
   Contém o prompt proprietário de análise e a instância/closers do Cal.
   ==================================================================== */

// Framework de análise de conteúdo injetado no prompt do modelo.
export const CORE_METHOD_CONTEXT = `
## SEU FRAMEWORK DE ANÁLISE
### Pilar 1: ...
### Pilar 2: ...
### Pilar 3: ...
`;

// Monta o prompt de diagnóstico (system + mensagem do usuário).
export function buildDiagnosisPrompt({ nome, instagram, nicho, desafio, faturamento, uf, fatos, temRoteiro }) {
  const system = 'Você é um consultor... (regras de tom e formato).';
  const userMsg = `${CORE_METHOD_CONTEXT}\n## CONTEXTO\n- Nome: ${nome}\n- @${instagram}\n${fatos}\n## INSTRUÇÕES\n...`;
  return { system, userMsg };
}

// Instância self-hosted do Cal e pool de closers (com os links reais).
export const CAL_BASE = 'https://SUA-INSTANCIA-CAL.example.com/interno';
export const VENDEDORES = [
  { nome: 'Closer 1', eventTypeId: 0, link: 'https://SUA-INSTANCIA-CAL.example.com/closer1/evento', trilha: 'premium' },
  // ...
];
