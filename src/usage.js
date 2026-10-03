'use strict';
// Contador de uso do Whisper (Groq, plano gratuito): 2.000 pedidos/dia, 28.800 s de áudio/dia e 7.200 s/hora,
// com mínimo de 10 s cobrados por pedido. Serve para avisar antes de bater no limite.

const fs = require('node:fs');
const path = require('node:path');

const LIMITS = { dayRequests: 2000, daySeconds: 28800, hourSeconds: 7200 };
const MIN_BILLED_S = 10;
const WARN_AT = 0.8;
const BYTES_PER_SECOND = 32000;   // WAV 16 kHz, mono, 16 bits

let file = null;
let events = [];   // { at, s } dos últimos 24 h
let now = () => Date.now();

function init(dir, opts = {}) {
  file = path.join(dir, 'usage.json');
  now = opts.now ?? now;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    events = Array.isArray(raw) ? raw.filter((e) => e && Number.isFinite(e.at) && Number.isFinite(e.s)) : [];
  } catch {
    events = [];
  }
  prune();
}

function prune() {
  const cut = now() - 24 * 3600e3;
  events = events.filter((e) => e.at > cut);
}

function save() {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(events)); } catch { /* só estatística */ }
}

/** Registra uma transcrição enviada ao Whisper. `bytes` é o tamanho do WAV. */
function recordStt(bytes) {
  prune();
  events.push({ at: now(), s: Math.max(MIN_BILLED_S, Math.ceil(bytes / BYTES_PER_SECOND)) });
  save();
}

function stats() {
  prune();
  const t = now();
  const hourSeconds = events.filter((e) => e.at > t - 3600e3).reduce((a, e) => a + e.s, 0);
  return {
    dayRequests: events.length,
    daySeconds: events.reduce((a, e) => a + e.s, 0),
    hourSeconds,
    limits: LIMITS,
  };
}

/** Frase para o Diagnóstico. */
function summary() {
  const u = stats();
  const pct = (v, max) => `${Math.round((v / max) * 100)}%`;
  return `Whisper nas últimas 24 h: ${u.dayRequests} de ${LIMITS.dayRequests} pedidos (${pct(u.dayRequests, LIMITS.dayRequests)}), ${u.daySeconds} de ${LIMITS.daySeconds} s de áudio (${pct(u.daySeconds, LIMITS.daySeconds)}); última hora: ${u.hourSeconds} de ${LIMITS.hourSeconds} s.`;
}

/** Texto de aviso quando perto do limite, ou ''. */
function warning() {
  const u = stats();
  if (u.dayRequests >= LIMITS.dayRequests * WARN_AT || u.daySeconds >= LIMITS.daySeconds * WARN_AT) return 'Você já usou a maior parte da cota diária gratuita de transcrição. Se acabar, o Jarvis para de entender voz até o limite renovar.';
  if (u.hourSeconds >= LIMITS.hourSeconds * WARN_AT) return 'Você está perto do limite de transcrição por hora. Se precisar, desligue a escuta e fale mais pouco por alguns minutos.';
  return '';
}

module.exports = { init, recordStt, stats, summary, warning, LIMITS, MIN_BILLED_S };
