/**
 * AudioWorkletProcessor that receives browser audio input,
 * downsamples to 16 kHz mono 16-bit linear PCM,
 * and emits ~40ms chunks (640 samples = 1280 bytes) to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetSampleRate = 16000;
    // 40 ms at 16,000 Hz = 640 samples
    this.chunkSize = 640;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const channelData = input[0]; // Float32Array mono
    const inputSampleRate = sampleRate; // Global AudioWorklet sampleRate

    // Downsample to 16 kHz if necessary
    if (inputSampleRate === this.targetSampleRate) {
      for (let i = 0; i < channelData.length; i++) {
        this.buffer.push(channelData[i]);
      }
    } else {
      const ratio = inputSampleRate / this.targetSampleRate;
      let targetIndex = 0;
      while (targetIndex * ratio < channelData.length) {
        const sourceIndex = targetIndex * ratio;
        const indexFloor = Math.floor(sourceIndex);
        const indexCeil = Math.min(channelData.length - 1, indexFloor + 1);
        const fraction = sourceIndex - indexFloor;
        // Linear interpolation
        const sample =
          channelData[indexFloor] * (1 - fraction) +
          channelData[indexCeil] * fraction;
        this.buffer.push(sample);
        targetIndex++;
      }
    }

    // When buffer reaches at least 40 ms (640 samples), convert to 16-bit PCM and post
    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.splice(0, this.chunkSize);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        // Clamp to [-1.0, 1.0] and scale to 16-bit signed integer [-32768, 32767]
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
