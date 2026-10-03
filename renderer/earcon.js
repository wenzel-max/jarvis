// Sons curtos de confirmação, sintetizados na hora (sem arquivos de áudio). Como o Jarvis não mostra legenda,
// um "blip" quando ele reconhece o seu pedido mostra na hora que te ouviu.

let ctx = null;

// [frequência em Hz, início em s, duração em s]
const TONES = {
  ok: [[880, 0, 0.07], [1320, 0.07, 0.1]],        // reconheceu: dois tons subindo
  on: [[660, 0, 0.07], [990, 0.07, 0.07], [1320, 0.14, 0.1]],   // escuta ligada
  off: [[1100, 0, 0.07], [740, 0.07, 0.07], [490, 0.14, 0.1]],  // escuta desligada: descendo
};

/** Toca um som curto e discreto. `kind`: 'ok' | 'on' | 'off'. */
export function playEarcon(kind = 'ok', volume = 0.1) {
  const tones = TONES[kind];
  if (!tones) return;
  try {
    ctx ??= new AudioContext();
    ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    for (const [freq, start, dur] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
  } catch { /* sem áudio: o som é só um extra */ }
}
