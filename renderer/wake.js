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

// ---------- comandos de música (Spotify) que não precisam da IA ----------
const UNITS = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
const TENS = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };

/** "50", "cinquenta", "vinte e cinco", "cem" -> número de 0 a 100 (ou null). */
export function parsePtNumber(text) {
  const k = speechKey(text).replace(/ por cento$/, '').replace(/%$/, '').trim();
  if (/^\d{1,3}$/.test(k)) return Math.min(100, Number(k));
  if (k === 'cem') return 100;
  const [a, e, b] = k.split(' ');
  if (a in TENS && (k === a || (e === 'e' && b in UNITS && UNITS[b] < 10 && UNITS[b] > 0 && !b?.includes(' ')))) return TENS[a] + (b ? UNITS[b] : 0);
  if (k in UNITS) return UNITS[k];
  return null;
}

const MEDIA = [
  ['pause', /^(pausa|pausar|pause|pausa a musica|pausar a musica|pausa o som|para a musica|pare a musica|parar a musica|para o som|silencia a musica)( por favor)?$/],
  ['resume', /^(retoma|retomar|continua|continuar|continue|solta|bota|coloca)( a| o)? ?(musica|som|tocar|tocando)( de novo)?( por favor)?$|^(despausa|despausar|toca de novo|volta a tocar|voltar a tocar)( por favor)?$/],
  ['next', /^(proxima|a proxima|proxima musica|proxima faixa|pula|pular|pula a musica|pular a musica|troca de musica|muda de musica|passa a musica)( por favor)?$/],
  ['previous', /^(anterior|a anterior|musica anterior|faixa anterior|volta a musica|voltar a musica|toca a anterior)( por favor)?$/],
  ['louder', /^(aumenta|aumentar|sobe|subir|mais alto|mais volume|volume mais alto)( o)?( volume| som)?( por favor)?$|^(aumenta|aumentar|sobe|subir) o (volume|som)( por favor)?$/],
  ['quieter', /^(abaixa|abaixar|diminui|diminuir|baixa|baixar|reduz|reduzir|mais baixo|menos volume|volume mais baixo)( o)?( volume| som)?( por favor)?$|^(abaixa|abaixar|diminui|diminuir|baixa|baixar|reduz|reduzir) o (volume|som)( por favor)?$/],
  ['now', /^(que musica e essa|qual musica e essa|qual e essa musica|o que esta tocando|que musica esta tocando|qual a musica)$/],
];
const VOLUME = /^(?:(?:coloca|bota|poe|ajusta|muda|deixa) o )?volume (?:(?:em|para|pra|no|a|na) )?(.+)$/;

/**
 * Comandos de música que valem sem IA. Devolve { action, value? } ou null.
 * Ações: pause, resume, next, previous, volume (value 0..100), louder, quieter, now.
 */
export function classifyMedia(command) {
  const k = speechKey(command);
  if (!k) return null;
  for (const [action, re] of MEDIA) if (re.test(k)) return { action };
  const v = VOLUME.exec(k);
  if (v) {
    if (/^(maximo|no maximo|o maximo)$/.test(v[1])) return { action: 'volume', value: 100 };
    if (/^(minimo|no minimo|o minimo|zero)$/.test(v[1])) return { action: 'volume', value: 0 };
    const n = parsePtNumber(v[1]);
    if (n != null) return { action: 'volume', value: n };
  }
  return null;
}
