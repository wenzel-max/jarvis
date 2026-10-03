'use strict';
// Modo de compatibilidade do microfone.
// Alguns drivers do Windows (ex.: Intel Smart Sound com efeitos de áudio) fazem a captura falhar com
// "Could not start audio source" dentro do sandbox do serviço de áudio do Chromium. Desligar esse
// sandbox costuma resolver, ao custo de isolar menos o processo de áudio; por isso é opcional.
// O interruptor precisa ser definido ANTES do app ficar pronto, então vale só após reiniciar.

const FEATURE = 'AudioServiceSandbox';

function applyMicCompat(app, enabled) {
  if (!enabled) return false;
  app.commandLine.appendSwitch('disable-features', FEATURE);
  return true;
}

module.exports = { applyMicCompat, FEATURE };
