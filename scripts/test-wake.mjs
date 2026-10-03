// Testa a palavra de ativação ("Jarvis") sem rede nem Electron.
import assert from 'node:assert';
import { parseCommand } from '../renderer/wake.js';

const casos = [
  ['Jarvis, que horas são?', true, 'que horas são?'],
  ['jarvis que dia é hoje', true, 'que dia é hoje'],
  ['Ei, Jarvis, abre o resumo do dia.', true, 'abre o resumo do dia.'],
  ['Ok Jarvis: me diga o clima', true, 'me diga o clima'],
  ['Jarves, tudo bem?', true, 'tudo bem?'],
  ['Garvis quanto é dois mais dois', true, 'quanto é dois mais dois'],
  ['Charvis, olá', true, 'olá'],
  ['Jarbis!', true, ''],
  ['Jarvis.', true, ''],
  ['  JÁRVIS  fala comigo ', true, 'fala comigo'],
  ['Que horas são?', false, 'Que horas são?'],
  ['Eu falei com o Jarvis ontem', false, 'Eu falei com o Jarvis ontem'],
  ['Servis o jantar agora', false, 'Servis o jantar agora'],
  ['Marvis e Garcia chegaram', false, 'Marvis e Garcia chegaram'],
  ['', false, ''],
  [undefined, false, ''],
];
for (const [texto, woke, command] of casos) {
  assert.deepStrictEqual(parseCommand(texto), { woke, command }, `"${texto}"`);
}
console.log(`ativação: ${casos.length} casos OK`);
