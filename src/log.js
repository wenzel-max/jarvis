'use strict';
// Registro de diagnóstico local (jarvis.log em userData). Como o Jarvis é só voz, erros e falas ignoradas
// não aparecem em lugar nenhum; aqui dá para ver o que ele ouviu e por que algo falhou (Ajustes, Diagnóstico).
// Segredos são removidos antes de gravar. O arquivo fica no PC e é cortado quando passa de MAX.

const fs = require('node:fs');
const path = require('node:path');

const MAX = 200 * 1024;
let file = null;
let writes = 0;

const redact = (s) => String(s)
  .replace(/gsk_[A-Za-z0-9_-]{10,}/g, 'gsk_***')
  .replace(/Bearer\s+\S+/gi, 'Bearer ***')
  .replace(/GOCSPX-[\w-]+/g, 'GOCSPX-***')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 700);

function trim() {
  try {
    if (fs.statSync(file).size > MAX) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-MAX / 2));
  } catch { /* sem arquivo ainda */ }
}

function init(dir) {
  file = path.join(dir, 'jarvis.log');
  trim();
}

function write(kind, message) {
  if (!file) return;
  const when = new Date().toLocaleString('sv-SE').slice(0, 19);   // 2026-10-03 20:45:10
  try {
    fs.appendFileSync(file, `${when} [${kind}] ${redact(message)}\n`);
    if (++writes % 100 === 0) trim();
  } catch { /* o registro nunca pode derrubar o app */ }
}

/** As últimas linhas, para mostrar nos Ajustes. */
function tail(lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function clear() {
  try { fs.writeFileSync(file, ''); } catch { /* ignora */ }
}

const location = () => file;

module.exports = { init, write, tail, clear, location, redact };
