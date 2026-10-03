'use strict';
// Perguntas e respostas com IA (Groq, plano gratuito, API compatível com OpenAI).
// A chave fica cifrada com safeStorage em userData e nunca vai para o renderer.

const fs = require('node:fs');
const path = require('node:path');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const STT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;   // ~15 s de fala em webm/opus tem poucas dezenas de KB
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const TOTAL_TIMEOUT_MS = 100000;   // uma pesquisa na web pode levar 30 s ou mais; o tempo de cada volta é limitado à parte
const TURN_TIMEOUT_MS = 30000;     // uma volta de conversa parada por mais que isso é falha
const MIN_SENTENCE = 25;   // frases muito curtas são juntadas à seguinte
const MIN_FIRST = 14;      // a primeira frase sai mais cedo: é ela que decide quando o Jarvis começa a falar
const MIN_FIRST_AT_COMMA = 30; // sem ponto final à vista, a primeira frase pode fechar numa vírgula
const MAX_SENTENCE = 280;  // o edge-tts aceita 600; cortar antes evita frases gigantes

let keyFile = null;
let fallbackKeyFile = null;
let active = null;         // AbortController da pergunta em andamento

function init(dir) {
  keyFile = path.join(dir, 'ai-key.bin');
  fallbackKeyFile = path.join(dir, 'ai-key-gemini.bin');
}

// ---------- chave ----------
const fileFor = (provider) => (provider === 'gemini' ? fallbackKeyFile : keyFile);
const hasKey = (provider = 'groq') => !!fileFor(provider) && fs.existsSync(fileFor(provider));

function setKey(raw, provider = 'groq') {
  const { safeStorage } = require('electron');
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    fs.rmSync(fileFor(provider), { force: true });
    return;
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new Error(`A chave tem formato inválido. Copie a chave inteira${provider === 'gemini' ? ', que começa com AIza' : ', que começa com gsk_'}.`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('O Windows não liberou o cofre de senhas, então a chave não pode ser guardada com segurança.');
  }
  fs.writeFileSync(fileFor(provider), safeStorage.encryptString(key));
}

function readKey(provider = 'groq') {
  try {
    const { safeStorage } = require('electron');
    return safeStorage.decryptString(fs.readFileSync(fileFor(provider)));
  } catch {
    return null;
  }
}

// ---------- texto falado ----------
/** Tira o que não faz sentido em voz alta (markdown, links, emojis). */
function cleanForSpeech(s) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recebe pedaços de texto e entrega frases completas assim que elas se fecham. */
class Sentencer {
  constructor(emit) {
    this.buf = '';
    this.emit = emit;
    this.sent = 0;   // quantas frases já saíram
  }

  push(text) {
    this.buf += text;
    for (;;) {
      const cut = this._cut();
      if (cut < 0) break;
      this._take(cut);
    }
  }

  flush() {
    this._take(this.buf.length);
  }

  _cut() {
    const first = this.sent === 0;
    const min = first ? MIN_FIRST : MIN_SENTENCE;
    const re = /[.!?…]+["')»\]]*(?=\s)|\n+/g;
    let m;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      if (cleanForSpeech(this.buf.slice(0, end)).length >= min) return end;
    }
    if (first) {   // a primeira frase não espera o ponto final se já há um trecho falável até uma vírgula
      const comma = /[,;:]\s/g;
      while ((m = comma.exec(this.buf))) {
        const end = m.index + 1;
        if (cleanForSpeech(this.buf.slice(0, end)).length >= MIN_FIRST_AT_COMMA) return end;
      }
    }
    if (this.buf.length > MAX_SENTENCE) {
      const at = Math.max(this.buf.lastIndexOf(', ', MAX_SENTENCE), this.buf.lastIndexOf(' ', MAX_SENTENCE));
      return at > 0 ? at + 1 : MAX_SENTENCE;
    }
    return -1;
  }

  _take(end) {
    const text = cleanForSpeech(this.buf.slice(0, end));
    this.buf = this.buf.slice(end);
    if (text) { this.sent++; this.emit(text); }
  }
}

// ---------- chamada ao Groq ----------
const httpErrors = (name) => ({
  401: `A chave do ${name} foi recusada. Confira a chave em Ajustes.`,
  403: `O ${name} negou o acesso com essa chave. Confira a conta e a chave em Ajustes.`,
  429: `Atingi o limite gratuito do ${name}. Tente de novo em alguns minutos.`,
});

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function systemPrompt({ userName, city, capabilities = [], memory = '' }) {
  const now = new Date();
  const agora = now.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const online = capabilities.includes('pesquisar na internet');
  return [
    `Você é o Jarvis, o assistente de voz de ${userName}. Vocês estão conversando em voz alta, como duas pessoas, e o que você escreve vai ser falado.`,
    'Fale como um brasileiro fala no dia a dia: natural, caloroso e direto. Use "tá", "pra" e "né" quando soar espontâneo, sem exagerar.',
    'Frases curtas e variadas, uma ideia por vez, em geral de uma a três frases. Vá direto ao ponto, sem repetir a pergunta e sem começar toda resposta com "claro" ou "com certeza".',
    'Nada de markdown, listas, tabelas, emojis nem links. Escreva números, horas e unidades como se fala ("vinte e oito graus", "três e meia").',
    'Se a pergunta for vaga, devolva uma pergunta curta. Se não souber, diga isso com naturalidade. Chame a pessoa pelo nome só de vez em quando.',
    capabilities.length
      ? `Você pode ${capabilities.join('; ')}. Use as ferramentas para isso, em vez de inventar. Antes de uma ferramenta demorada, como pesquisar, diga uma frase curtinha ("Deixa eu ver isso."). Depois de usar uma ferramenta, conte o resultado de forma natural e curta, sem ler ids. Se a ferramenta falhar ou não achar nada, diga isso com franqueza em uma frase, nunca fique em silêncio e nunca prometa checar de novo. Datas como "amanhã" ou "sexta" você calcula a partir de agora: ${localIso(now)} (fuso ${tz}).`
      : '',
    online ? '' : 'Você não tem acesso à internet nem ao computador do usuário nesta conversa.',
    `Agora é ${agora}. O usuário mora em ${city}.`,
    memory,
  ].filter(Boolean).join(' ');
}

/** Traduz uma resposta de erro do Groq em mensagem em português; marca erros de modelo. */
async function throwHttpError(res, model, name = 'Groq') {
  if (res.status === 429 || res.status >= 500) {   // o provedor está limitado ou fora do ar: vale tentar o reserva
    const err = new Error(res.status === 429 ? httpErrors(name)[429] : `O ${name} respondeu com erro ${res.status}. Tente de novo em instantes.`);
    err.canFallback = true;
    throw err;
  }
  if (httpErrors(name)[res.status]) throw new Error(httpErrors(name)[res.status]);
  const { message, code } = await errorDetail(res);
  if (code === 'tool_use_failed') {   // o modelo montou uma chamada de ferramenta inválida: tenta responder sem ferramentas
    const err = new Error('O modelo se confundiu ao usar uma ferramenta.');
    err.isToolError = true;
    throw err;
  }
  if (res.status === 404 || /model/i.test(`${code} ${message}`)) {
    const err = new Error(`O Groq não aceitou o modelo "${model}". Troque o modelo em Ajustes.`);
    err.isModelError = true;
    throw err;
  }
  if (res.status === 400) throw new Error(`O ${name} recusou o pedido${message ? `: ${message}` : '.'}`);
  throw new Error(`O ${name} respondeu com erro ${res.status}. Tente de novo em instantes.`);
}

async function errorDetail(res) {
  try {
    const j = await res.json();
    return { message: String(j.error?.message ?? '').slice(0, 200), code: String(j.error?.code ?? '') };
  } catch {
    return { message: '', code: '' };
  }
}

// Modelos que não servem para conversa por texto.
const NOT_CHAT = /whisper|tts|speech|guard|safeguard|embed|orpheus|playai|moderation/i;
// Ordem de preferência: pequenos e rápidos primeiro (voz pede resposta ágil).
const PREFERRED_CHAT = [/llama.*8b.*instant/i, /8b/i, /instant|flash|mini/i, /llama-3\.3-70b/i, /llama/i, /./];
// Só Whisper multilíngue: os "distil-whisper" e variantes "-en" são apenas em inglês.
const PREFERRED_STT = [/^whisper.*turbo/i, /^whisper/i];
const PREFERRED_WEB = [/compound-mini/i, /compound/i];
const STT_ENGLISH_ONLY = /distil|[-.]en$/i;

/** Lista os IDs de modelos que a conta tem acesso. */
async function listModels({ key, signal, endpoint = ENDPOINT }) {
  const res = await fetch(endpoint.replace(/\/(chat\/completions|audio\/transcriptions)$/, '/models'), {
    signal,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string').sort();
}

/** Escolhe outro modelo da lista para substituir um que o Groq recusou. kind: 'chat' ou 'stt'. */
async function pickModel({ key, bad, signal, endpoint, kind = 'chat' }) {
  try {
    const stt = kind === 'stt';
    const web = kind === 'web';
    const ids = (await listModels({ key, signal, endpoint }))
      .filter((id) => id !== bad && (web ? /compound/i.test(id) : stt ? /^whisper/i.test(id) && !STT_ENGLISH_ONLY.test(id) : !NOT_CHAT.test(id)));
    for (const re of web ? PREFERRED_WEB : stt ? PREFERRED_STT : PREFERRED_CHAT) {
      const hit = ids.find((id) => re.test(id));
      if (hit) return hit;
    }
  } catch { /* sem lista, a mensagem de erro original orienta o usuário */ }
  return null;
}

/**
 * Faz a pergunta e entrega a resposta em frases (onSentence) conforme chegam.
 * Devolve o texto completo. `endpoint` existe só para testes.
 */
async function streamTurn({ key, model, messages, tools, toolChoice = 'auto', signal, onSentence, endpoint = ENDPOINT, name = 'Groq' }) {
  const withTools = tools?.length > 0;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, messages, stream: true, temperature: withTools ? 0.4 : 0.6, max_tokens: 400,
        ...(withTools ? { tools, tool_choice: toolChoice, ...(name === 'Groq' ? { parallel_tool_calls: false } : {}) } : {}),
      }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    const err = new Error(`Sem conexão com o ${name}. Verifique a internet.`);
    err.canFallback = true;
    throw err;
  }
  if (!res.ok) await throwHttpError(res, model, name);

  const sentencer = new Sentencer(onSentence);
  const decoder = new TextDecoder();
  const calls = new Map();   // as chamadas de ferramenta chegam em pedaços, por índice
  let pending = '';
  let full = '';
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let delta;
      try { delta = JSON.parse(data).choices?.[0]?.delta; } catch { continue; }
      if (delta?.content) {
        full += delta.content;
        sentencer.push(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        // o Gemini manda várias chamadas sem índice: uma chamada nova é a que traz um id novo
        const idx = tc.index ?? (tc.id && calls.size && [...calls.values()].at(-1).id !== tc.id ? calls.size : Math.max(0, calls.size - 1));
        const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }
  sentencer.flush();
  return { text: full.trim(), toolCalls: [...calls.values()].filter((c) => c.name) };
}

/** Conversa sem ferramentas: devolve só o texto. */
async function streamChat(opts) {
  return (await streamTurn(opts)).text;
}

const ROLES = new Set(['user', 'assistant']);

/** Valida o histórico vindo do renderer: só user/assistant, texto curto, no máximo 8 mensagens. */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && ROLES.has(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
}

/** Entrada usada pelo IPC. Nunca lança: devolve { text } ou { error, aborted }. */
const MAX_TOOL_STEPS = 4;
const TOOL_RESULT_MAX = 3000;

/** Argumentos de ferramenta chegam como texto JSON; se vierem quebrados, a ferramenta recebe {}. */
function parseArgs(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function ask({ question, history }, { settings, onSentence, endpoint, key: keyOverride, tools, fillerMs = 7000, turnTimeoutMs = TURN_TIMEOUT_MS, fallback: fallbackOverride, onFallback }) {
  const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
  if (!q) return { error: 'Digite uma pergunta.' };
  const key = keyOverride ?? readKey();
  if (!key) return { error: 'Falta a chave do Groq. Cole a chave em Ajustes, na seção Inteligência artificial.' };

  cancel();
  const ctrl = new AbortController();
  active = ctrl;
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TOTAL_TIMEOUT_MS);
  try {
    const defs = tools?.definitions() ?? [];
    const messages = [
      { role: 'system', content: systemPrompt({ userName: settings.userName, city: settings.city.name, capabilities: tools?.capabilities() ?? [], memory: tools?.memoryBlock?.(settings.userName) ?? '' }) },
      ...sanitizeHistory(history),
      { role: 'user', content: q },
    ];
    let model = settings.aiModel;
    let provider = { key, endpoint, name: 'Groq' };
    // Reserva (Gemini): só entra se a chave existe e o Groq estiver limitado, fora do ar ou sem conexão.
    const fb = fallbackOverride ?? (() => { const k = readKey('gemini'); return k ? { key: k, endpoint: GEMINI_ENDPOINT, name: 'Gemini', model: settings.fallbackModel } : null; })();
    // 'auto': o modelo escolhe; 'none': as ferramentas continuam na lista (a API exige isso quando há chamadas
    // no histórico) mas ele não pode chamar mais nenhuma; 'off': nunca houve ferramentas.
    let mode = defs.length > 0 ? 'auto' : 'off';
    const turn = async () => {
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(turnTimeoutMs)]);
      let emitted = false;
      const say = (t) => { emitted = true; onSentence(t); };
      const run = () => streamTurn({ key: provider.key, model, messages, tools: mode === 'off' ? undefined : defs, toolChoice: mode === 'none' ? 'none' : 'auto', signal, onSentence: say, endpoint: provider.endpoint, name: provider.name });
      try {
        return await run();
      } catch (e) {
        if (e.canFallback && fb && provider.name === 'Groq' && !emitted && !ctrl.signal.aborted) {
          provider = fb;
          model = fb.model || 'gemini-2.5-flash';
          onFallback?.(e.message);
          return run();
        }
        if (e.isToolError && mode === 'auto') { mode = 'none'; return run(); }   // sem poder chamar ferramentas, pelo menos responde
        // Modelo recusado (renomeado ou aposentado): troca por um que a conta tenha e tenta de novo.
        if (!e.isModelError || ctrl.signal.aborted) throw e;
        const alt = await pickModel({ key: provider.key, bad: model, signal: ctrl.signal, endpoint: provider.endpoint });
        if (!alt) throw e;
        model = alt;
        return run();
      }
    };

    // Enquanto uma ferramenta demora (pesquisa na web), o Jarvis avisa em voz alta que ainda está trabalhando.
    const withProgress = async (work) => {
      const timers = [fillerMs, fillerMs * 3].map((ms, i) => setTimeout(() => {
        if (!ctrl.signal.aborted) onSentence(i === 0 ? 'Só mais um instante.' : 'Ainda estou procurando, só mais um pouquinho.');
      }, ms));
      try { return await work(); } finally { timers.forEach(clearTimeout); }
    };

    let spoken = '';
    for (let step = 0; ; step++) {
      const t = await turn();
      spoken = `${spoken} ${t.text}`.trim();
      if (!t.toolCalls.length || mode !== 'auto') break;
      if (step >= MAX_TOOL_STEPS) {   // preso em ferramentas: força uma resposta com o que já tem
        mode = 'none';
        messages.push({ role: 'user', content: 'Responda agora com o que você já tem.' });
        spoken = `${spoken} ${(await turn()).text}`.trim();
        break;
      }
      messages.push({
        role: 'assistant', content: t.text || null,
        tool_calls: t.toolCalls.map((c, i) => ({ id: c.id || `call_${step}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
      });
      for (const [i, c] of t.toolCalls.entries()) {
        const result = await withProgress(() => tools.run(c.name, parseArgs(c.arguments), { signal: ctrl.signal }));
        messages.push({ role: 'tool', tool_call_id: c.id || `call_${step}_${i}`, content: String(result).slice(0, TOOL_RESULT_MAX) });
      }
    }
    if (!spoken) return { error: 'O Groq não devolveu resposta. Tente de novo.' };
    return { text: spoken, model, provider: provider.name };
  } catch (e) {
    if (ctrl.signal.aborted) {
      const timedOut = ctrl.signal.reason?.message === 'timeout';
      return timedOut ? { error: 'O Groq demorou demais para responder. Tente de novo.' } : { aborted: true };
    }
    if (e.name === 'TimeoutError') return { error: 'O Groq demorou demais para responder. Tente de novo.' };
    return { error: e.message };
  } finally {
    clearTimeout(timer);
    if (active === ctrl) active = null;
  }
}

// ---------- busca na internet (modelo Compound do Groq, com busca embutida) ----------
const WEB_SYSTEM = 'Você pesquisa na web para um assistente de voz. Responda em português do Brasil, só com os fatos, em até quatro frases curtas, sem markdown, sem links e sem listas. Diga a data ou o horário quando forem relevantes. Se não achar, diga que não achou.';

async function webSearch(query, { settings, key: keyOverride, signal, endpoint = ENDPOINT, onSetting } = {}) {
  const key = keyOverride ?? readKey();
  if (!key) return 'Falta a chave do Groq, então não consigo pesquisar.';
  const ask1 = async (model) => {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST', signal: signal ?? AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: WEB_SYSTEM }, { role: 'user', content: query }], max_tokens: 500, temperature: 0.2 }),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error('Sem conexão com o Groq. Verifique a internet.');
    }
    if (!res.ok) await throwHttpError(res, model);
    const j = await res.json();
    return cleanForSpeech(String(j.choices?.[0]?.message?.content ?? ''));
  };
  let model = settings?.webModel ?? 'groq/compound-mini';
  let text;
  try {
    text = await ask1(model);
  } catch (e) {
    if (!e.isModelError) throw e;
    const alt = await pickModel({ key, bad: model, signal, endpoint, kind: 'web' });
    if (!alt) return 'A busca na internet não está disponível na sua conta do Groq agora.';
    model = alt;
    text = await ask1(model);
    onSetting?.('webModel', alt);
  }
  return text ? text.slice(0, 1500) : 'A pesquisa não trouxe nada útil.';
}

// ---------- voz de entrada (Whisper no Groq) ----------
// O Whisper "alucina" frases de legenda quando só ouve ruído; isso não é fala do usuário.
const HALLUCINATION = /amara\.org|legendas? (pela|por|de)|obrigad[oa] por assistir|inscreva-se|^[\s.…!?-]*$/i;

async function transcribeAudio({ key, model, audio, mime, signal, endpoint = STT_ENDPOINT }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `fala.${AUDIO_TYPES[mime]}`);
  form.append('model', model);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', signal, headers: { Authorization: `Bearer ${key}` }, body: form });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error('Sem conexão com o Groq. Verifique a internet.');
  }
  if (!res.ok) await throwHttpError(res, model);
  const j = await res.json();
  return String(j.text ?? '').trim();
}

/** Entrada do IPC: devolve { text, model } ou { error }. Nunca lança. */
async function transcribe({ audio, mime }, { settings, endpoint, key: keyOverride }) {
  const type = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  if (!AUDIO_TYPES[type]) return { error: 'O formato do áudio gravado não é aceito.' };
  const bytes = audio instanceof ArrayBuffer ? Buffer.from(audio) : ArrayBuffer.isView(audio) ? Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength) : null;
  if (!bytes || !bytes.length) return { error: 'Não consegui gravar o áudio. Tente de novo.' };
  if (bytes.length > MAX_AUDIO_BYTES) return { error: 'A gravação ficou longa demais. Fale uma frase por vez.' };
  const key = keyOverride ?? readKey();
  if (!key) return { error: 'Falta a chave do Groq. Cole a chave em Ajustes, na seção Inteligência artificial.' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    let model = settings.sttModel;
    const run = () => transcribeAudio({ key, model, audio: bytes, mime: type, signal: ctrl.signal, endpoint });
    let text;
    try {
      text = await run();
    } catch (e) {
      if (!e.isModelError || ctrl.signal.aborted) throw e;
      const alt = await pickModel({ key, bad: model, signal: ctrl.signal, endpoint, kind: 'stt' });
      if (!alt) throw e;
      model = alt;
      text = await run();
    }
    if (!text || HALLUCINATION.test(text)) return { error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' };
    return { text, model };
  } catch (e) {
    return { error: ctrl.signal.aborted ? 'O Groq demorou demais para transcrever. Tente de novo.' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function cancel() {
  active?.abort();
  active = null;
}

module.exports = { init, hasKey, setKey, ask, transcribe, cancel, webSearch, streamChat, streamTurn, listModels, pickModel, Sentencer, cleanForSpeech };
