// Testa a palavra de ativação ("Jarvis") sem rede nem Electron.
import assert from 'node:assert';
import { parseCommand, classifyShort, speechKey } from '../renderer/wake.js';

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
  ['Obrigado, Jarvis', true, 'Obrigado'],
  ['Que horas são, Jarvis?', true, 'Que horas são'],
  ['Me diz uma coisa sobre o tempo em Natal, Jarvis', true, 'Me diz uma coisa sobre o tempo em Natal'],
  ['Ei, Jarvis', true, ''],
  ['Oi Jarvis', true, ''],
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

const curtas = [
  ['Para!', 'stop'], ['Pare.', 'stop'], ['chega', 'stop'], ['Deixa pra lá', 'stop'], ['Tá bom.', 'stop'], ['Silêncio', 'stop'], ['não precisa', 'stop'],
  ['Obrigado!', 'thanks'], ['Valeu, Jarvis', 'thanks'], ['Muito obrigada.', 'thanks'], ['Perfeito', 'thanks'],
  ['Para de tocar a música', null], ['Que horas são?', null], ['Chega mais perto', null], ['', null], [undefined, null],
];
for (const [texto, esperado] of curtas) assert.strictEqual(classifyShort(texto), esperado, `"${texto}"`);
assert.strictEqual(speechKey('  Olá, Jarvis!  Tá?'), 'ola jarvis ta');
console.log(`ativação: ${casos.length} casos OK; frases curtas: ${curtas.length} casos OK`);
