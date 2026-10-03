'use strict';
// Lembretes e timers: guardados em reminders.json (sobrevivem a reiniciar o app) e disparados por um relógio
// único que acorda no próximo horário. Se o PC dormiu ou o app estava fechado na hora, avisa assim que puder.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PENDING = 50;
const MAX_AHEAD_MS = 366 * 24 * 3600e3;
const MISSED_GRACE_MS = 24 * 3600e3;     // lembrete perdido há mais que isso é descartado
const LATE_MS = 90000;                   // atrasado além disso, o aviso diz que o horário já tinha passado
const MAX_WAIT_MS = 2 * 3600e3;          // reconfere ao menos de 2 em 2 horas (relógio mudou, PC dormiu)

let file = null;
let items = [];
let timer = null;
let onFire = () => {};
let now = () => Date.now();
let setT = setTimeout;
let clearT = clearTimeout;

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function save() {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(items));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* sem disco: os lembretes valem até fechar o app */ }
}

/** `now`, `setTimer` e `clearTimer` existem só para testes. */
function init(dir, opts = {}) {
  file = path.join(dir, 'reminders.json');
  onFire = opts.onFire ?? onFire;
  now = opts.now ?? now;
  setT = opts.setTimer ?? setTimeout;
  clearT = opts.clearTimer ?? clearTimeout;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === 'string' && typeof r.text === 'string' && Number.isFinite(r.at)) : [];
  } catch {
    items = [];
  }
  items.sort((a, b) => a.at - b.at);
  schedule();
}

function schedule() {
  clearT(timer);
  timer = null;
  if (!items.length) return;
  timer = setT(tick, Math.min(Math.max(0, items[0].at - now()), MAX_WAIT_MS));
  timer?.unref?.();
}

function tick() {
  const t = now();
  const due = items.filter((r) => r.at <= t);
  items = items.filter((r) => r.at > t);
  save();          // grava antes de avisar: se o app cair agora, o aviso não repete
  for (const r of due) {
    if (t - r.at > MISSED_GRACE_MS) continue;
    try { onFire({ ...r, late: t - r.at > LATE_MS }); } catch { /* um aviso com defeito não derruba os outros */ }
  }
  schedule();
}

function add({ text, at, kind = 'lembrete' }) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) throw new Error('Faltou dizer do que lembrar.');
  if (!Number.isFinite(at)) throw new Error('Não entendi o horário.');
  if (at < now() - 60000) throw new Error('Esse horário já passou.');
  if (at > now() + MAX_AHEAD_MS) throw new Error('Só consigo lembrar de coisas dentro de um ano.');
  if (items.length >= MAX_PENDING) throw new Error('Já tem lembretes demais pendentes. Cancele algum antes.');
  const r = { id: crypto.randomBytes(3).toString('hex'), text: clean, at: Math.max(at, now()), kind, created: now() };
  items.push(r);
  items.sort((a, b) => a.at - b.at);
  save();
  schedule();
  return { ...r };
}

function addIn(minutes, text, kind) {
  const m = Number(minutes);
  if (!(m > 0) || m > 525600) throw new Error('Os minutos precisam estar entre 1 e 525600 (um ano).');
  return add({ text, at: now() + Math.round(m * 60000), kind });
}

const list = () => items.map((r) => ({ ...r }));

/** Cancela por id ou por um pedaço do texto. Devolve o que foi cancelado, ou null. */
function cancel(ref) {
  const key = norm(ref);
  if (!key) return null;
  const i = items.findIndex((r) => r.id === key || norm(r.text).includes(key));
  if (i < 0) return null;
  const [gone] = items.splice(i, 1);
  save();
  schedule();
  return gone;
}

module.exports = { init, add, addIn, list, cancel, tick, MAX_PENDING };
