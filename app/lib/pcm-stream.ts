/** Keeps fractional sample boundaries across worklet blocks (e.g. 44.1kHz). */
export class PcmStreamEncoder {
  private ratio: number;
  private filled = 0;
  private sum = 0;
  constructor(inputRate: number, outputRate = 16_000) {
    if (!Number.isFinite(inputRate) || inputRate < outputRate || outputRate <= 0) throw new Error("Unsupported audio sample rate");
    this.ratio = inputRate / outputRate;
  }
  encode(input: Float32Array): ArrayBuffer {
    const samples: number[] = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const weight = Math.min(remaining, this.ratio - this.filled);
        this.sum += (Number.isFinite(sample) ? sample : 0) * weight;
        this.filled += weight;
        remaining -= weight;
        if (this.filled >= this.ratio - 1e-9) {
          samples.push(Math.max(-1, Math.min(1, this.sum / this.ratio)));
          this.filled = 0; this.sum = 0;
        }
      }
    }
    const bytes = new ArrayBuffer(samples.length * 2);
    const view = new DataView(bytes);
    samples.forEach((sample, i) => view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true));
    return bytes;
  }
}
