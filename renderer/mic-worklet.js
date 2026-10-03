// Captura do microfone fora da thread da interface (AudioWorklet). Junta os blocos de 128 amostras
// em blocos maiores e os entrega ao Mic; o tamanho vem de processorOptions.block.
class JarvisCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.block || 2048;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.size - this.fill);
      this.buf.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) {
        this.port.postMessage(this.buf);   // copia estruturada: o buffer volta a ser reaproveitado
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('jarvis-capture', JarvisCapture);
