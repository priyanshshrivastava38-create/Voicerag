// AudioWorklet: microphone → 16 kHz mono PCM16 frames of 20 ms (320 samples) with RMS.
// Runs on the audio rendering thread; posts transferable buffers to the main thread.
// If the AudioContext already runs at 16 kHz no resampling happens (ratio = 1).
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; // fractional read position into the incoming stream
    this.frame = new Int16Array(320);
    this.fi = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear-interpolation resampler (adequate for speech; the browser capture path already
    // band-limits voice input). With a 16 kHz context, ratio = 1 and samples pass through.
    let p = this.pos;
    while (p < ch.length) {
      const i = p | 0;
      const f = p - i;
      const b = i + 1 < ch.length ? ch[i + 1] : ch[i];
      const x = Math.max(-1, Math.min(1, ch[i] + (b - ch[i]) * f));
      this.frame[this.fi++] = x < 0 ? x * 0x8000 : x * 0x7fff;
      this.sumSq += x * x;
      if (this.fi === 320) {
        const rms = Math.sqrt(this.sumSq / 320);
        const out = this.frame;
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this.frame = new Int16Array(320);
        this.fi = 0;
        this.sumSq = 0;
      }
      p += this.ratio;
    }
    this.pos = p - ch.length;
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
