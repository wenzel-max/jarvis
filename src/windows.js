'use strict';
// Controle do Windows por voz: volume e bloquear a tela. Só scripts FIXOS (o único dado variável é um número
// validado). Desligar e reiniciar o PC não existem de propósito.

const { execFile } = require('node:child_process');

const KEY = { down: 174, mute: 173, up: 175 };   // teclas de mídia: cada toque muda 2% no volume
const sendKeys = (code, times) => `$w=New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${code}) }`;

function script(action, value) {
  switch (action) {
    case 'volume_mais': return sendKeys(KEY.up, 5);
    case 'volume_menos': return sendKeys(KEY.down, 5);
    case 'mudo': return sendKeys(KEY.mute, 1);
    case 'volume': {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('O volume precisa ser um número de 0 a 100.');
      // zera (50 toques) e sobe até o valor: 1 toque = 2%
      return `$w=New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $w.SendKeys([char]${KEY.down}) }; ${n >= 2 ? `1..${Math.round(n / 2)} | ForEach-Object { $w.SendKeys([char]${KEY.up}) }` : ''}`;
    }
    default: return null;
  }
}

const SAID = {
  volume_mais: 'Aumentei o volume do computador.',
  volume_menos: 'Abaixei o volume do computador.',
  mudo: 'Alternei o mudo do computador.',
  volume: 'Ajustei o volume do computador.',
  bloquear_tela: 'Bloqueei a tela.',
};

/** `run(arquivo, argumentos)` devolve uma Promise; é trocado nos testes. */
async function control(action, value, { platform = process.platform, run = defaultRun } = {}) {
  if (platform !== 'win32') throw new Error('Esse controle só funciona no Windows.');
  if (action === 'bloquear_tela') {
    await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    return SAID[action];
  }
  const ps = script(action, value);
  if (!ps) throw new Error('Não sei fazer essa ação no Windows.');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  return SAID[action];
}

const defaultRun = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 15000 }, (err) => (err ? reject(new Error('O Windows não executou o comando.')) : resolve()));
});

module.exports = { control, script, SAID };
