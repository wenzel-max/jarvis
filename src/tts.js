'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EdgeTTS, listVoices } = require('edge-tts-universal');

const MAX_CACHE_FILES = 300;
const SYNTH_TIMEOUT_MS = 6000;
const FALLBACK_VOICES = [
  { id: 'pt-BR-AntonioNeural', name: 'Antonio', gender: 'Male' },
  { id: 'pt-BR-FranciscaNeural', name: 'Francisca', gender: 'Female' },
  { id: 'pt-BR-ThalitaMultilingualNeural', name: 'Thalita', gender: 'Female' },
];

let cacheDir = null;
let voicesCache = null;

function init(dir) {
  cacheDir = dir;
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function listPtBrVoices() {
  if (voicesCache) return voicesCache;
  try {
    const all = await listVoices();
    const list = all
      .filter((v) => v.Locale === 'pt-BR')
      .map((v) => ({
        id: v.ShortName,
        name: v.ShortName.replace(/^pt-BR-/, '').replace(/(Multilingual)?Neural$/, ''),
        gender: v.Gender,
      }));
    if (list.length) {
      voicesCache = list;
      return list;
    }
  } catch (e) {
    console.warn('[tts] lista de vozes indisponível, usando padrão:', e.message);
  }
  return FALLBACK_VOICES;
}

const signed = (n, unit) => `${n >= 0 ? '+' : ''}${Math.round(n)}${unit}`;

function prune() {
  try {
    const files = fs.readdirSync(cacheDir)
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f } of files.slice(0, Math.max(0, files.length - MAX_CACHE_FILES))) {
      fs.unlinkSync(path.join(cacheDir, f));
    }
  } catch { /* cache é só otimização */ }
}

/** Devolve um Buffer MP3. Frases repetidas saem do cache em disco. */
async function synthesize({ text, voice, rate = 0, pitch = 0, cacheOnly = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Texto vazio.');
  text = text.trim().slice(0, 600);
  voice = typeof voice === 'string' ? voice : 'pt-BR-AntonioNeural';

  const key = crypto.createHash('sha1').update([text, voice, rate, pitch].join('|')).digest('hex');
  const file = path.join(cacheDir, `${key}.mp3`);
  if (fs.existsSync(file)) {
    try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* só ordem de limpeza */ }   // usada há pouco: não sai do cache
    return fs.readFileSync(file);
  }
  if (cacheOnly) throw new Error('Frase fora do cache e serviço de voz indisponível.');

  // A biblioteca não tem prazo próprio: sem internet ela ficaria esperando para sempre.
  const tts = new EdgeTTS(text, voice, { rate: signed(rate, '%'), pitch: signed(pitch, 'Hz') });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Sem resposta do serviço de voz em ${SYNTH_TIMEOUT_MS / 1000} s.`)), SYNTH_TIMEOUT_MS);
  });
  const result = await Promise.race([tts.synthesize(), timeout]).finally(() => clearTimeout(timer));
  const buf = Buffer.from(await result.audio.arrayBuffer());
  if (!buf.length) throw new Error('O serviço de voz devolveu áudio vazio.');
  fs.writeFileSync(file, buf);
  prune();
  return buf;
}

/**
 * Deixa no cache as frases curtas que o Jarvis repete muito, para respondê-las na hora (e até offline).
 * Roda em segundo plano, uma de cada vez; para na primeira falha (sem internet) e tenta de novo no próximo boot.
 */
async function prewarm(phrases, opts, { pauseMs = 400, shouldStop = () => false } = {}) {
  let made = 0;
  for (const text of phrases) {
    if (shouldStop()) break;
    try {
      await synthesize({ text, ...opts, cacheOnly: true });   // já está no cache
    } catch {
      try { await synthesize({ text, ...opts }); made++; } catch { break; }
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  return made;
}

module.exports = { init, listPtBrVoices, synthesize, prewarm };
