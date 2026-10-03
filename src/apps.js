'use strict';
// Abrir programas por voz, SÓ de uma lista permitida. A IA escolhe um nome da lista; ela nunca monta o comando.
// Isso importa: uma página da web pesquisada poderia tentar enganá-la para executar algo.

const BUILTIN = {
  'calculadora': 'calc.exe',
  'bloco de notas': 'notepad.exe',
  'explorador de arquivos': 'explorer.exe',
  'gerenciador de tarefas': 'taskmgr.exe',
  'configuracoes': 'ms-settings:',
  'navegador': 'https://www.google.com',
};
const DISPLAY = { configuracoes: 'configurações' };

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const WINDOWS_FILE = /^[A-Za-z]:\\[^<>"|?*\r\n]{1,250}\.(exe|lnk|bat|cmd)$/i;
const WEB = /^https?:\/\/[^\s]{3,300}$/i;
const URI = /^(ms-settings|spotify|steam|discord|whatsapp|calculator):[^\s]{0,200}$/i;

/** Só caminhos de programa do Windows, endereços web ou atalhos de aplicativos conhecidos. */
const isValidTarget = (t) => typeof t === 'string' && (WINDOWS_FILE.test(t) || WEB.test(t) || URI.test(t));

/** Lista de { name, target } válidos: os padrões do Jarvis mais os que o usuário cadastrou em Ajustes. */
function entries(custom = []) {
  const map = new Map();
  for (const [key, target] of Object.entries(BUILTIN)) map.set(key, { name: DISPLAY[key] ?? key, target });
  for (const c of Array.isArray(custom) ? custom : []) {
    if (c && typeof c.name === 'string' && c.name.trim() && isValidTarget(c.target)) map.set(norm(c.name), { name: c.name.trim().slice(0, 40), target: c.target });
  }
  return [...map.values()];
}

/**
 * Abre um programa da lista. `openPath(caminho)` devolve '' se deu certo ou o texto do erro;
 * `openExternal(url)` abre endereços e atalhos. Lança Error com uma frase para o usuário.
 */
async function open(name, custom, { openPath, openExternal }) {
  const key = norm(name);
  if (!key) throw new Error('Faltou dizer qual programa abrir.');
  const list = entries(custom);
  const hit = list.find((e) => norm(e.name) === key) ?? list.find((e) => norm(e.name).includes(key) || key.includes(norm(e.name)));
  if (!hit) throw new Error(`"${name}" não está na lista de programas que posso abrir. Os que posso abrir: ${list.map((e) => e.name).join(', ')}. Você cadastra mais em Ajustes.`);
  if (WEB.test(hit.target) || URI.test(hit.target)) {
    await openExternal(hit.target);
  } else {
    const err = await openPath(hit.target);
    if (err) throw new Error(`Não consegui abrir ${hit.name}: ${err}`);
  }
  return hit.name;
}

module.exports = { open, entries, isValidTarget };
