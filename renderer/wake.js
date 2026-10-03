// Palavra de ativação: o Jarvis só age quando ouve o nome dele no começo da frase.

const stripAccents = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// O Whisper escreve "Jarvis" de várias formas: Jarvis, Jarves, Garvis, Charvis, Jarbis...
const WAKE_WORD = /^(?:dj|j|g|ch|x)[ae]r[vb][eiy][sz]?$/;
const WORDS_TO_LOOK_AT = 4;   // "Ei, Jarvis, que horas são?" ainda conta; "Eu falei com o Jarvis ontem" não

/** Separa o nome do Jarvis (nas primeiras palavras) do resto da frase. */
export function parseCommand(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.min(WORDS_TO_LOOK_AT, words.length); i++) {
    if (WAKE_WORD.test(stripAccents(words[i]))) {
      return { woke: true, command: words.slice(i + 1).join(' ').replace(/^[\s,.:;!?\-–]+/, '').trim() };
    }
  }
  return { woke: false, command: words.join(' ') };
}
