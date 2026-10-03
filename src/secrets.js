'use strict';
// Cofre de segredos: cada item (tokens do Google, do Spotify...) vai cifrado com o safeStorage do
// Electron (no Windows usa a proteção do usuário) em userData. Nunca vai para o renderer nem para o settings.json.

const fs = require('node:fs');
const path = require('node:path');

let dir = null;
let safe = null;

/** `safeStorage` é injetado para poder testar sem o Electron. */
function init(userDataDir, safeStorage) {
  dir = userDataDir;
  safe = safeStorage;
}

const file = (name) => {
  if (!/^[a-z0-9-]{1,30}$/.test(name)) throw new Error('Nome de segredo inválido.');
  return path.join(dir, `${name}.bin`);
};

const has = (name) => !!dir && fs.existsSync(file(name));

function set(name, value) {
  if (!safe?.isEncryptionAvailable()) {
    throw new Error('O Windows não liberou o cofre de senhas, então não dá para guardar isto com segurança.');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(name), safe.encryptString(JSON.stringify(value)));
}

/** Devolve o objeto guardado, ou null se não existe ou não pôde ser lido. */
function get(name) {
  try {
    return JSON.parse(safe.decryptString(fs.readFileSync(file(name))));
  } catch {
    return null;
  }
}

const remove = (name) => fs.rmSync(file(name), { force: true });

module.exports = { init, has, get, set, remove };
