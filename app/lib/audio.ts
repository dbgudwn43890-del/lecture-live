export const STT_SAMPLE_RATE = 16_000;

export function downsampleAudio(
  input: Float32Array,
  inputRate: number,
  outputRate = STT_SAMPLE_RATE,
) {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || outputRate <= 0) {
    throw new Error("Invalid audio sample rate.");
  }
  if (inputRate === outputRate) return input.slice();

  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);

  if (inputRate < outputRate) {
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * (input.length - 1) / Math.max(1, outputLength - 1);
      const left = Math.floor(sourcePosition);
      const right = Math.min(input.length - 1, left + 1);
      const mix = sourcePosition - left;
      output[index] = input[left] * (1 - mix) + input[right] * mix;
    }
    return output;
  }

  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    output[index] = sum / (end - start);
  }
  return output;
}

export function encodeWav(samples: Float32Array, sampleRate = STT_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  function writeText(offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * bytesPerSample, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}
