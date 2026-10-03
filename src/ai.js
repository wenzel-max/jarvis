'use strict';
// Perguntas e respostas com IA (Groq, plano gratuito, API compatível com OpenAI).
// A chave fica cifrada com safeStorage em userData e nunca vai para o renderer.

const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TOTAL_TIMEOUT_MS = 40000;
const MIN_SENTENCE = 25;   // frases muito curtas são juntadas à seguinte
const MAX_SENTENCE = 280;  // o edge-tts aceita 600; cortar antes evita frases gigantes

let keyFile = null;
let active = null;         // AbortController da pergunta em andamento

function init(dir) {
  keyFile = path.join(dir, 'ai-key.bin');
}

// ---------- chave ----------
const hasKey = () => !!keyFile && fs.existsSync(keyFile);

function setKey(raw) {
  const { safeStorage } = require('electron');
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    fs.rmSync(keyFile, { force: true });
    return;
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new Error('A chave tem formato inválido. Copie a chave inteira, que começa com gsk_.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('O Windows não liberou o cofre de senhas, então a chave não pode ser guardada com segurança.');
  }
  fs.writeFileSync(keyFile, safeStorage.encryptString(key));
}

function readKey() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage.decryptString(fs.readFileSync(keyFile));
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
    const re = /[.!?…]+["')»\]]*(?=\s)|\n+/g;
    let m;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      if (cleanForSpeech(this.buf.slice(0, end)).length >= MIN_SENTENCE) return end;
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
    if (text) this.emit(text);
  }
}

// ---------- chamada ao Groq ----------
const HTTP_ERRORS = {
  401: 'A chave do Groq foi recusada. Confira a chave em Ajustes.',
  403: 'O Groq negou o acesso com essa chave. Confira a conta e a chave em Ajustes.',
  429: 'Atingi o limite gratuito do Groq. Tente de novo em alguns minutos.',
};

function systemPrompt({ userName, city }) {
  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  return [
    `Você é o Jarvis, o assistente pessoal de ${userName} no computador dele.`,
    'Responda sempre em português do Brasil, em tom natural e direto, com no máximo três frases curtas, a menos que peçam mais detalhes.',
    'Sua resposta será falada em voz alta: não use markdown, listas, tabelas, emojis nem links, e escreva números e unidades como se fala.',
    'Se não souber ou não tiver como saber, diga isso com franqueza. Você não tem acesso à internet nem ao computador do usuário nesta conversa.',
    `Agora é ${agora}. O usuário mora em ${city}.`,
  ].join(' ');
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
const PREFERRED = [/llama.*8b.*instant/i, /8b/i, /instant|flash|mini/i, /llama-3\.3-70b/i, /llama/i, /./];

/** Lista os modelos de conversa que a conta tem acesso. */
async function listModels({ key, signal, endpoint = ENDPOINT }) {
  const res = await fetch(endpoint.replace(/\/chat\/completions$/, '/models'), {
    signal,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string' && !NOT_CHAT.test(id)).sort();
}

/** Escolhe outro modelo da lista para substituir um que o Groq recusou. */
async function pickModel({ key, bad, signal, endpoint }) {
  try {
    const ids = (await listModels({ key, signal, endpoint })).filter((id) => id !== bad);
    for (const re of PREFERRED) {
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
async function streamChat({ key, model, messages, signal, onSentence, endpoint = ENDPOINT }) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.6, max_tokens: 400 }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error('Sem conexão com o Groq. Verifique a internet.');
  }
  if (!res.ok) {
    if (HTTP_ERRORS[res.status]) throw new Error(HTTP_ERRORS[res.status]);
    const { message, code } = await errorDetail(res);
    if (res.status === 404 || /model/i.test(`${code} ${message}`)) {
      const err = new Error(`O Groq não aceitou o modelo "${model}". Troque o modelo em Ajustes.`);
      err.isModelError = true;
      throw err;
    }
    if (res.status === 400) throw new Error(`O Groq recusou o pedido${message ? `: ${message}` : '.'}`);
    throw new Error(`O Groq respondeu com erro ${res.status}. Tente de novo em instantes.`);
  }

  const sentencer = new Sentencer(onSentence);
  const decoder = new TextDecoder();
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
      try { delta = JSON.parse(data).choices?.[0]?.delta?.content; } catch { continue; }
      if (delta) {
        full += delta;
        sentencer.push(delta);
      }
    }
  }
  sentencer.flush();
  return full.trim();
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
async function ask({ question, history }, { settings, onSentence, endpoint, key: keyOverride }) {
  const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
  if (!q) return { error: 'Digite uma pergunta.' };
  const key = keyOverride ?? readKey();
  if (!key) return { error: 'Falta a chave do Groq. Cole a chave em Ajustes, na seção Inteligência artificial.' };

  cancel();
  const ctrl = new AbortController();
  active = ctrl;
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TOTAL_TIMEOUT_MS);
  try {
    const messages = [
      { role: 'system', content: systemPrompt({ userName: settings.userName, city: settings.city.name }) },
      ...sanitizeHistory(history),
      { role: 'user', content: q },
    ];
    let model = settings.aiModel;
    const run = () => streamChat({ key, model, messages, signal: ctrl.signal, onSentence, endpoint });
    let text;
    try {
      text = await run();
    } catch (e) {
      // Modelo recusado (renomeado ou aposentado): troca por um que a conta tenha e tenta de novo.
      if (!e.isModelError || ctrl.signal.aborted) throw e;
      const alt = await pickModel({ key, bad: model, signal: ctrl.signal, endpoint });
      if (!alt) throw e;
      model = alt;
      text = await run();
    }
    if (!text) return { error: 'O Groq não devolveu resposta. Tente de novo.' };
    return { text, model };
  } catch (e) {
    if (ctrl.signal.aborted) {
      const timedOut = ctrl.signal.reason?.message === 'timeout';
      return timedOut ? { error: 'O Groq demorou demais para responder. Tente de novo.' } : { aborted: true };
    }
    return { error: e.message };
  } finally {
    clearTimeout(timer);
    if (active === ctrl) active = null;
  }
}

function cancel() {
  active?.abort();
  active = null;
}

module.exports = { init, hasKey, setKey, ask, cancel, streamChat, listModels, pickModel, Sentencer, cleanForSpeech };
