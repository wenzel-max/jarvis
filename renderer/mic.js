// Microfone sempre aberto: detecta sozinho quando você fala, corta cada frase e entrega em WAV 16 kHz.
// Também mede o volume (0..1) para a esfera pulsar enquanto o Jarvis ouve.

const BLOCK = 2048;                // amostras por bloco de áudio (~43 ms a 48 kHz)
const CALIBRATION_MS = 500;        // mede o ruído do ambiente antes de decidir o que é voz
const PREROLL_MS = 400;            // guarda o que veio antes da voz, para não cortar a primeira sílaba
const START_BLOCKS = 2;            // blocos seguidos acima do limiar para considerar que começou a fala
const BARGE_BLOCKS = 6;            // fala por cima do Jarvis: precisa durar ~250 ms, para eco e estalos não o interromperem
const BARGE_MIN_THRESHOLD = 0.03;  // e ser bem mais forte que o ruído de fundo (sobra de eco das caixas de som)
const SILENCE_SHORT_MS = 850;      // fim de frase depois de pouca fala ("Jarvis..." pode vir seguido de uma pausa)
const SILENCE_LONG_MS = 600;       // fim de frase depois de uma fala mais longa: responde mais rápido
const SHORT_SPEECH_MS = 900;
const KEEP_TRAILING_MS = 250;      // do silêncio final, só isso vai para o Whisper (menos áudio, resposta mais rápida)
const MIN_VOICED_MS = 280;         // menos voz que isso é estalo ou tosse, não fala
const MAX_SEGMENT_MS = 20000;      // frase longa demais é cortada e enviada
const WHISPER_RATE = 16000;        // taxa nativa do Whisper; também deixa o arquivo pequeno
const MAX_CANDIDATES = 8;

// Microfones virtuais (Steam, mesa de som, OBS...) abrem sem erro mas só entregam silêncio.
const VIRTUAL = /steam|virtual|vb-audio|voicemeeter|cable|obs\b|nvidia broadcast|stereo mix|mixagem|loopback|blackhole|soundflower/i;
const ALIASES = new Set(['default', 'communications']);

/** Tira o prefixo que o Chromium põe nos atalhos ("Default - ", "Communications - "). */
export const cleanLabel = (label) => (label || '').replace(/^(default|communications|padrão|comunicações)\s+-\s+/i, '').trim();

/** Lista as entradas de áudio. Os nomes só aparecem depois que o microfone foi aberto uma vez. */
export async function listMicrophones() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set();
    return all
      .filter((d) => d.kind === 'audioinput' && d.deviceId && !seen.has(d.deviceId) && seen.add(d.deviceId))
      .map((d) => ({ id: d.deviceId, label: d.label || '', alias: ALIASES.has(d.deviceId), virtual: VIRTUAL.test(d.label || '') }));
  } catch {
    return [];
  }
}

/** Ordem de tentativa: o escolhido, microfones reais, atalhos do sistema, virtuais por último. */
function rank(d, preferred) {
  if (preferred && cleanLabel(d.label).toLowerCase().includes(preferred.toLowerCase())) return d.alias ? 0.5 : 0;
  if (d.alias) return d.virtual ? 4 : 2;
  return d.virtual ? 3 : 1;
}

/** Resumo do que foi tentado em cada dispositivo, para as mensagens de erro. */
export function describeReport(report) {
  if (!report?.length) return '';
  return report
    .map((r) => `${cleanLabel(r.label) || 'padrão'}: ${r.ok ? 'abriu' : `recusou (${r.why})`}`)
    .join('; ');
}

const COMPAT_HINT = ' Dica: em Ajustes, ligue o Modo de compatibilidade do microfone e reinicie o Jarvis.';

/** Mensagens em português para os erros de acesso ao microfone. */
export function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O Windows bloqueou o microfone. Ative em Configurações, Privacidade e segurança, Microfone, e permita apps da área de trabalho.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Não encontrei nenhum microfone. Conecte um e tente de novo.';
    case 'NotReadableError': {
      const tried = describeReport(err.report);
      return `Não consegui abrir o microfone, mesmo tentando todas as formas. Feche programas que possam estar usando, como Discord, Teams ou chamadas no navegador.${tried ? ` Tentei: ${tried}.` : ''} Detalhe técnico: ${err.message || 'sem detalhe'}${COMPAT_HINT}`;
    }
    default:
      return 'Não consegui usar o microfone. Tente de novo.';
  }
}

/** Volume em % (0..100) a partir do rms, na mesma escala da esfera. */
const pct = (rms) => Math.round(Math.min(1, rms * 5) * 100);

/** Explica, com os números medidos, por que não houve fala. */
export function explainNoSpeech(stats, report) {
  if (!stats) return 'Não ouvi nada. Aperte Falar e tente de novo.';
  const dev = stats.label ? `"${cleanLabel(stats.label)}"` : 'o microfone';
  const tried = describeReport(report);
  const refused = report?.some((r) => !r.ok && !VIRTUAL.test(r.label));
  const extra = `${tried ? ` Dispositivos testados: ${tried}.` : ''}${refused ? COMPAT_HINT : ''}`;
  if (stats.peak < 0.003) {
    const virtual = VIRTUAL.test(stats.label || '') ? ' Esse é um microfone virtual, que não capta som: escolha o microfone real em Ajustes.' : '';
    return `O Jarvis abriu ${dev}, mas só chegou silêncio (nível ${pct(stats.peak)}%).${virtual} Veja se o microfone não está mudo (tecla do notebook, Configurações, Sistema, Som, Entrada) e se o volume de entrada está alto.${extra}`;
  }
  return `O Jarvis abriu ${dev}, mas o volume ficou baixo (nível máximo ${pct(stats.peak)}%). Fale mais perto e mais alto e tente de novo.${extra}`;
}

/** Junta blocos Float32, converte para 16 kHz mono e empacota como WAV 16 bits. */
function encodeWav(blocks, sampleRate) {
  let total = 0;
  for (const b of blocks) total += b.length;
  const ratio = sampleRate / WHISPER_RATE;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  // média simples de cada janela de entrada (filtro passa-baixa barato antes de reduzir a taxa)
  let bi = 0, bo = 0;
  const at = (i) => {
    while (bi < blocks.length && i - bo >= blocks[bi].length) { bo += blocks[bi].length; bi++; }
    return blocks[bi]?.[i - bo] ?? 0;
  };
  for (let o = 0; o < outLen; o++) {
    const start = Math.floor(o * ratio);
    const end = Math.max(start + 1, Math.floor((o + 1) * ratio));
    let sum = 0;
    for (let i = start; i < end; i++) sum += at(i);
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    pcm[o] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (off, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(off + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, WHISPER_RATE, true); dv.setUint32(28, WHISPER_RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

export class Mic {
  constructor() {
    this.level = 0;        // volume atual, 0..1
    this.stats = null;     // { label, peak, speechMs } desde que abriu
    this.report = [];      // o que foi tentado em cada dispositivo na última abertura
    this.preferred = '';   // parte do nome do microfone escolhido pelo usuário ('' = automático)
    this.running = false;
    this.paused = false;
    this.duck = false;           // false | 'thinking' | 'speaking': o que o Jarvis está fazendo agora
    this.bargeIn = true;         // se falso, o microfone fica mudo enquanto o Jarvis fala (caixas de som sem fone)
    this.onBargeIn = null;       // () => void; você começou a falar por cima do Jarvis
    this.onSpeechStart = null;   // () => void
    this.onSpeechEnd = null;     // ({ buffer, mime, ms } | null) => void; null = foi só barulho
    this._graph = null;
    this._seg = null;            // fala em andamento
    this._preroll = [];
    this._floor = Infinity;
    this._calibMs = 0;
    this._loud = 0;
  }

  /**
   * Abre o microfone. Drivers como o "Grupo de microfones" da Intel Smart Sound recusam a
   * configuração padrão do navegador (NotReadableError), e o "padrão" do Windows às vezes é um
   * microfone virtual mudo. Por isso: abre o padrão (isso revela os nomes), ordena os
   * dispositivos (reais antes de virtuais) e tenta cada um com várias configurações.
   */
  async _open() {
    const report = [];
    this.report = report;
    const gum = (audio) => navigator.mediaDevices.getUserMedia({ audio });
    const fatal = (err) => err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    const why = (err) => `${err?.name ?? 'erro'}${err?.message ? `: ${err.message}` : ''}`;
    let firstError = null;

    // 0) o padrão do sistema: dá a permissão e revela os nomes dos dispositivos
    let fallback = null;
    for (const c of [{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, true]) {
      try {
        fallback = await gum(c);
        break;
      } catch (err) {
        firstError ??= err;
        if (fatal(err)) throw err;
        console.warn('[microfone] padrão recusado:', err?.name, err?.message);
      }
    }
    const fallbackLabel = cleanLabel(fallback?.getAudioTracks()[0]?.label);
    if (fallback) report.push({ label: fallbackLabel || 'padrão', ok: true });
    else report.push({ label: 'padrão', ok: false, why: why(firstError) });

    // 1) o melhor candidato; se o padrão que abriu já é ele, acabou
    const ordered = (await listMicrophones())
      .map((d) => ({ d, r: rank(d, this.preferred) }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.d)
      .slice(0, MAX_CANDIDATES);
    if (fallback && (!ordered.length || cleanLabel(ordered[0].label) === fallbackLabel)) return fallback;

    // 2) tenta cada dispositivo, do melhor para o pior
    for (const d of ordered) {
      if (fallback && cleanLabel(d.label) === fallbackLabel) continue;   // já sabemos que abre
      const exact = { deviceId: { exact: d.id } };
      const variants = [exact, { ...exact, channelCount: 1 }, { ...exact, channelCount: 2 },
        { ...exact, sampleRate: 48000 }, { ...exact, sampleRate: 44100 }, { ...exact, sampleRate: 16000, channelCount: 1 }];
      let lastError = null;
      for (const v of variants) {
        try {
          const stream = await gum(v);
          fallback?.getTracks().forEach((t) => t.stop());
          report.push({ label: d.label, ok: true });
          return stream;
        } catch (err) {
          firstError ??= err;
          lastError = err;
          if (fatal(err)) throw err;
        }
      }
      report.push({ label: d.label, ok: false, why: why(lastError) });
    }

    if (fallback) return fallback;
    const error = firstError ?? new Error('Nenhum microfone disponível.');
    error.report = report;
    throw error;
  }

  /** Abre o microfone e começa a escutar. Lança o erro do getUserMedia se não for possível. */
  async start() {
    if (this.running) return;
    const stream = await this._open();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor está marcado como obsoleto, mas funciona no Electron e evita um arquivo extra de worklet.
    const proc = ctx.createScriptProcessor(BLOCK, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;                 // o processador precisa estar ligado à saída, sem tocar nada
    src.connect(proc);
    proc.connect(mute).connect(ctx.destination);
    proc.onaudioprocess = (e) => this._onBlock(e.inputBuffer.getChannelData(0), ctx.sampleRate);
    this._graph = { stream, ctx, proc, src, mute };
    this.stats = { label: stream.getAudioTracks()[0]?.label ?? '', peak: 0, speechMs: 0 };
    this._floor = Infinity;
    this._calibMs = 0;
    this._seg = null;
    this._preroll = [];
    this._loud = 0;
    this.running = true;
  }

  stop() {
    const g = this._graph;
    this._graph = null;
    this.running = false;
    this._seg = null;
    this.level = 0;
    if (!g) return;
    g.proc.onaudioprocess = null;
    g.stream.getTracks().forEach((t) => t.stop());
    g.ctx.close().catch(() => {});
  }

  /** Enquanto pausado, o áudio é descartado (o Jarvis não deve ouvir a própria voz). */
  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      this._seg = null;
      this._preroll = [];
      this._loud = 0;
      this.level = 0;
    }
  }

  /**
   * O que o Jarvis está fazendo: false (nada), 'thinking' (pensando: sem som saindo, então qualquer fala firme sua
   * é uma continuação) ou 'speaking' (falando: o limiar sobe para não confundir a voz dele, o eco, com a sua).
   * `true` vale como 'speaking'.
   */
  setDuck(mode) {
    this.duck = mode === true ? 'speaking' : mode || false;
    if (this.duck) this._loud = 0;
  }

  /** Zera o pico medido (usado pelo teste de microfone). */
  resetStats() {
    if (this.stats) { this.stats.peak = 0; this.stats.speechMs = 0; }
  }

  _onBlock(data, sampleRate) {
    if (!this.running) return;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const blockMs = (data.length / sampleRate) * 1000;
    if (this.paused || (this.duck && !this.bargeIn)) { this.level = 0; return; }

    this.level = Math.min(1, rms * 5);
    this.stats.peak = Math.max(this.stats.peak, rms);

    if (this._calibMs < CALIBRATION_MS) {      // aprende o ruído do ambiente (o menor volume visto)
      this._floor = Math.min(this._floor, rms);
      this._calibMs += blockMs;
      return;
    }
    // O ruído de fundo continua sendo acompanhado enquanto ninguém fala.
    if (!this._seg && rms < this._floor * 3.5) this._floor = this._floor * 0.97 + rms * 0.03;
    let threshold = Math.min(0.04, Math.max(0.006, this._floor * 3.5));
    if (this.duck === 'speaking' && !this._seg) threshold = Math.max(threshold * 2, BARGE_MIN_THRESHOLD);
    const voiced = rms > threshold;
    if (voiced) this.stats.speechMs += blockMs;
    const copy = Float32Array.from(data);

    if (!this._seg) {
      this._preroll.push(copy);
      while (this._preroll.length * blockMs > PREROLL_MS) this._preroll.shift();
      this._loud = voiced ? this._loud + 1 : 0;
      if (this._loud >= (this.duck ? BARGE_BLOCKS : START_BLOCKS)) {
        const barge = this.duck;
        this._seg = { blocks: [...this._preroll], sampleRate, voicedMs: 0, silentMs: 0, silentBlocks: 0, ms: this._preroll.length * blockMs, barge };
        this._preroll = [];
        this._loud = 0;
        if (barge) { this.duck = false; this.onBargeIn?.(); } else this.onSpeechStart?.();
      }
      return;
    }

    const seg = this._seg;
    seg.blocks.push(copy);
    seg.ms += blockMs;
    if (voiced) { seg.voicedMs += blockMs; seg.silentMs = 0; seg.silentBlocks = 0; } else { seg.silentMs += blockMs; seg.silentBlocks++; }
    const silenceNeeded = seg.voicedMs < SHORT_SPEECH_MS ? SILENCE_SHORT_MS : SILENCE_LONG_MS;
    if (seg.silentMs >= silenceNeeded || seg.ms >= MAX_SEGMENT_MS) {
      this._seg = null;
      if (seg.voicedMs < MIN_VOICED_MS) { this.onSpeechEnd?.(null); return; }
      const extra = seg.silentBlocks - Math.ceil(KEEP_TRAILING_MS / blockMs);
      if (extra > 0) seg.blocks.length -= extra;
      this.onSpeechEnd?.({ buffer: encodeWav(seg.blocks, seg.sampleRate), mime: 'audio/wav', ms: seg.ms, barge: seg.barge });
    }
  }
}
