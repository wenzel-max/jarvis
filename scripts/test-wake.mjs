// Testa a palavra de ativação ("Jarvis") sem rede nem Electron.
import assert from 'node:assert';
import { parseCommand, classifyShort, speechKey, classifyMedia, parsePtNumber } from '../renderer/wake.js';

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
  ['Gervis, que horas são?', true, 'que horas são?'],
  ['Jarvi, abre a agenda', true, 'abre a agenda'],
  ['Yarvis quanto é dois mais dois', true, 'quanto é dois mais dois'],
  ['Já vis, que dia é hoje?', true, 'que dia é hoje?'],
  ['Jar vis, olá', true, 'olá'],
  ['Jarbas, que horas são?', true, 'que horas são?'],
  ['Já vi esse filme ontem', false, 'Já vi esse filme ontem'],
  ['Garcia chegou cedo hoje', false, 'Garcia chegou cedo hoje'],
  ['Servis o jantar agora', false, 'Servis o jantar agora'],
  ['Que horas são?', false, 'Que horas são?'],
  ['Eu falei com o Jarvis ontem', false, 'Eu falei com o Jarvis ontem'],
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
curtas.push(['para de escutar', 'sleep'], ['Para de me escutar', 'sleep'], ['pode parar de ouvir', 'sleep'], ['não escute mais', 'sleep'], ['entra em modo de espera', 'sleep'], ['para de escutar por favor', 'sleep'], ['para', 'stop'], ['para a música', null]);
// escondido na bandeja (strict): só o nome quase exato acorda
for (const t of ['Jarvis, que horas são?', 'Jarves que horas são', 'Garvis que horas são', 'Ei Jarvis tudo bem']) assert.ok(parseCommand(t, { strict: true }).woke, `strict deve acordar: ${t}`);
for (const t of ['Garis que horas são', 'Jarbas que horas são', 'Chaves tá aberto', 'Eu comprei um jarro novo', 'gravis agora']) {
  assert.ok(!parseCommand(t, { strict: true }).woke, `strict NÃO deve acordar: ${t}`);
}
assert.ok(parseCommand('Jarbas que horas são').woke);   // com a janela aberta continua valendo
for (const [texto, esperado] of curtas) assert.strictEqual(classifyShort(texto), esperado, `"${texto}"`);
assert.strictEqual(speechKey('  Olá, Jarvis!  Tá?'), 'ola jarvis ta');

const nums = [['50', 50], ['100', 100], ['250', 100], ['cem', 100], ['cinquenta', 50], ['vinte e cinco', 25], ['trinta e um', 31], ['quinze', 15], ['zero', 0], ['oitenta por cento', 80], ['40%', 40], ['sei la', null], ['vinte e', null], ['vinte e dez', null]];
for (const [t, n] of nums) assert.strictEqual(parsePtNumber(t), n, `número "${t}"`);

const media = [
  ['Pausa', 'pause'], ['Pausar a música.', 'pause'], ['Para a música!', 'pause'], ['pausa o som por favor', 'pause'],
  ['Continua a música', 'resume'], ['retoma', null], ['retoma a música', 'resume'], ['Volta a tocar', 'resume'], ['despausa', 'resume'],
  ['Próxima', 'next'], ['Pula a música', 'next'], ['próxima música', 'next'], ['troca de música', 'next'],
  ['Anterior', 'previous'], ['volta a música', 'previous'], ['música anterior', 'previous'],
  ['Aumenta o volume', 'louder'], ['mais alto', 'louder'], ['sobe o volume', 'louder'],
  ['Abaixa o volume.', 'quieter'], ['diminui o som', 'quieter'], ['mais baixo', 'quieter'],
  ['Que música é essa?', 'now'], ['O que está tocando?', 'now'],
  ['Para!', null], ['Para de falar', null], ['Que horas são?', null], ['Toca Legião Urbana', null], ['Pula de alegria', null], ['Continua', null], ['', null],
];
for (const [t, a] of media) assert.strictEqual(classifyMedia(t)?.action ?? null, a, `mídia "${t}"`);
const vol = [['Volume 50', 50], ['volume em 30', 30], ['coloca o volume em cinquenta', 50], ['Volume no máximo', 100], ['volume no mínimo', 0], ['bota o volume para vinte e cinco por cento', 25], ['volume 120', 100]];
for (const [t, v] of vol) assert.deepStrictEqual(classifyMedia(t), { action: 'volume', value: v }, `volume "${t}"`);
assert.strictEqual(classifyMedia('volume bonito'), null);
console.log(`ativação: ${casos.length} casos OK; frases curtas: ${curtas.length} casos OK; música: ${media.length + vol.length} casos OK`);
