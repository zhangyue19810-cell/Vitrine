/**
 * Small interface sounds, synthesised with the Web Audio API (no audio files are shipped).
 * The audio context is created on the first sound, which always follows a click or key press, and is suspended
 * again a few seconds later so an idle launcher never keeps the audio device awake.
 */

export type SoundName = "tick" | "column" | "open" | "close" | "confirm" | "error" | "launch" | "done";

class SoundBoard {
  enabled = true;
  volume = 0.5;
  private ctx?: AudioContext;
  private suspendTimer?: ReturnType<typeof setTimeout>;
  private lastTick = 0;

  configure(enabled: boolean, volume: number) {
    this.enabled = enabled;
    this.volume = Math.max(0, Math.min(1, volume));
    if (!enabled) this.suspendNow();
  }

  play(name: SoundName, pan = 0) {
    if (!this.enabled || this.volume <= 0.001) return;
    if (document.visibilityState === "hidden") return;
    const ctx = this.context();
    if (!ctx) return;
    // Scrolling through the shelf must not turn into a machine gun.
    const now = performance.now();
    if (name === "tick" && now - this.lastTick < 45) return;
    if (name === "tick") this.lastTick = now;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t = ctx.currentTime + 0.005;
    const out = this.output(ctx, pan);
    try {
      switch (name) {
        case "tick":
          this.click(ctx, out, t, 2300, 0.55);
          this.tone(ctx, out, t, 150, 0.05, "sine", 0.16, 110);
          break;
        case "column":
          this.click(ctx, out, t, 1500, 0.6);
          this.tone(ctx, out, t, 110, 0.09, "sine", 0.2, 80);
          break;
        case "open":
          this.tone(ctx, out, t, 520, 0.13, "sine", 0.2);
          this.tone(ctx, out, t + 0.07, 780, 0.16, "sine", 0.18);
          break;
        case "close":
          this.tone(ctx, out, t, 700, 0.1, "sine", 0.16);
          this.tone(ctx, out, t + 0.06, 460, 0.14, "sine", 0.16);
          break;
        case "confirm":
          [523.25, 659.25, 783.99].forEach((f, i) => this.tone(ctx, out, t + i * 0.055, f, 0.2, "triangle", 0.16));
          break;
        case "error":
          this.tone(ctx, out, t, 190, 0.14, "square", 0.1);
          this.tone(ctx, out, t + 0.17, 150, 0.2, "square", 0.1);
          break;
        case "launch":
          this.sweep(ctx, out, t, 180, 900, 0.8);
          break;
        case "done":
          [659.25, 783.99, 1046.5].forEach((f, i) => this.tone(ctx, out, t + i * 0.09, f, 0.45, "sine", 0.18));
          break;
      }
    } catch {
      /* a failed sound must never break the interface */
    }
    this.scheduleSuspend();
  }

  private context(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      this.enabled = false;
    }
    return this.ctx;
  }

  private output(ctx: AudioContext, pan: number): AudioNode {
    const gain = ctx.createGain();
    gain.gain.value = this.volume * 0.5;
    let last: AudioNode = gain;
    if (pan && typeof ctx.createStereoPanner === "function") {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      last = panner;
    }
    last.connect(ctx.destination);
    return gain;
  }

  private tone(ctx: AudioContext, out: AudioNode, at: number, freq: number, length: number, type: OscillatorType, level: number, endFreq?: number) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, at + length);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(level, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }

  private click(ctx: AudioContext, out: AudioNode, at: number, centre: number, level: number) {
    const length = 0.028;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = centre;
    filter.Q.value = 1.4;
    const env = ctx.createGain();
    env.gain.value = level;
    source.connect(filter).connect(env).connect(out);
    source.start(at);
  }

  private sweep(ctx: AudioContext, out: AudioNode, at: number, from: number, to: number, length: number) {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + length);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(400, at);
    filter.frequency.exponentialRampToValueAtTime(5200, at + length);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.12, at + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(filter).connect(env).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  private scheduleSuspend() {
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => this.suspendNow(), 6000);
  }

  private suspendNow() {
    clearTimeout(this.suspendTimer);
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend().catch(() => {});
  }
}

export const sound = new SoundBoard();
