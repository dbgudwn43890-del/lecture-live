class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const remaining = this.buffer.length - this.offset;
      const amount = Math.min(remaining, channel.length - sourceOffset);
      this.buffer.set(channel.subarray(sourceOffset, sourceOffset + amount), this.offset);
      this.offset += amount;
      sourceOffset += amount;

      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(4096);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
