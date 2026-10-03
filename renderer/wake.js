// Palavra de ativação: o Jarvis só age quando ouve o nome dele no começo da frase.

const stripAccents = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// O Whisper escreve "Jarvis" de várias formas: Jarvis, Jarves, Garvis, Charvis, Jarbis...
const WAKE_WORD = /^(?:dj|j|g|ch|x)[ae]r[vb][eiy][sz]?$/;
const WORDS_TO_LOOK_AT = 4;   // "Ei, Jarvis, que horas são?" ainda conta; "Eu falei com o Jarvis ontem" não

const trimEdges = (s) => s.replace(/^[\s,.:;!?\-–]+/, '').replace(/[\s,;:\-–]+$/, '').trim();

/**
 * Separa o nome do Jarvis do resto da frase. O nome vale nas primeiras palavras ("Jarvis, que horas são?",
 * "Ei, Jarvis, ...") ou como última palavra ("Que horas são, Jarvis?"). Se não sobra nada depois do nome,
 * o pedido é o que veio antes dele ("Obrigado, Jarvis").
 */
export function parseCommand(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const isName = (w) => WAKE_WORD.test(stripAccents(w));
  for (let i = 0; i < Math.min(WORDS_TO_LOOK_AT, words.length); i++) {
    if (!isName(words[i])) continue;
    const after = trimEdges(words.slice(i + 1).join(' '));
    const before = trimEdges(words.slice(0, i).join(' '));
    const bare = /^(ei|ola|oi|ok|okay|hey|hei|e ai|bom dia|boa tarde|boa noite)$/.test(speechKey(before));   // só uma saudação antes do nome
    return { woke: true, command: after || (bare ? '' : before) };
  }
  const last = words.length - 1;
  if (last >= WORDS_TO_LOOK_AT && isName(words[last])) {
    return { woke: true, command: trimEdges(words.slice(0, last).join(' ')) };
  }
  return { woke: false, command: words.join(' ') };
}

/** Texto sem acento, pontuação nem maiúsculas, para comparar palavras soltas. */
export const speechKey = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP_WORDS = /^(para|pare|parar|chega|chega ai|silencio|calma|espera|espere|cancela|cancelar|esquece|esqueca|deixa|deixa pra la|deixa quieto|deixa pra la jarvis|nada|nao|nao precisa|ok|certo|ta bom|ta|beleza|tudo bem|entendi|isso|isso mesmo|uhum|aham|hum)$/;
const THANKS = /^(obrigado|obrigada|muito obrigado|muito obrigada|valeu|brigado|brigada|show|legal|perfeito|otimo|massa)( jarvis)?$/;

/**
 * Frases curtas que não precisam da IA: "para", "chega" (calar e ficar quieto) e "obrigado" (resposta rápida).
 * Devolve 'stop', 'thanks' ou null.
 */
export function classifyShort(command) {
  const k = speechKey(command);
  if (!k) return null;
  if (THANKS.test(k)) return 'thanks';
  if (STOP_WORDS.test(k)) return 'stop';
  return null;
}
