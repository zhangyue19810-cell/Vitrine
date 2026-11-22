/**
 * The music as the scene sees it: a row of frequency bands, each 0 … 1, smoothed so that a hit jumps up quickly and falls
 * back slowly. Pure numbers (no DOM, no three.js): the player feeds it from a Web Audio analyser, or — when the browser
 * does not let the page read the audio of another origin — from a made-up groove of the same shape; the stage reads it
 * and lets every archive jump with the band that lies under it (bass at the focus, treble at the far end).
 */

export const SPECTRUM_BANDS = 20;

/** What the stage needs to know about the music. */
export interface SpectrumField {
  /** True while anything still moves (the stage keeps drawing); false once everything has fallen back to rest. */
  readonly active: boolean;
  /** Changes whenever the bands changed, so a consumer can skip its work when nothing did. */
  readonly version: number;
  /** 1 on a bass hit, falling back to 0 within a fraction of a second. */
  readonly beat: number;
  /** Mean of all bands, 0 … 1. */
  readonly energy: number;
  /** The band energy at `x` (0 … 1 across the bands, interpolated), 0 … 1. */
  at(x: number): number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Where the `bands` log-spaced bands between `low` and `high` Hz start and end in an analyser's bins: band i covers the
 * bins `edges[i] … edges[i + 1] − 1`. Every band gets at least one bin, so the lowest ones are single bins.
 */
export function bandEdges(bands: number, binCount: number, sampleRate: number, low = 45, high = 14000): Int32Array {
  const width = sampleRate / 2 / Math.max(1, binCount);
  const first = Math.max(1, Math.min(binCount - 1, Math.round(low / width)));
  const last = Math.max(first + bands, Math.min(binCount, Math.round(high / width)));
  const ratio = Math.pow(last / first, 1 / bands);
  const edges = new Int32Array(bands + 1);
  edges[0] = first;
  for (let i = 1; i <= bands; i++) {
    const wanted = i === bands ? last : Math.round(first * Math.pow(ratio, i));
    edges[i] = Math.max(edges[i - 1] + 1, wanted);
  }
  return edges;
}

/** The loudness (0 … 1) of each band from one analyser reading (`bins` are bytes, 0 … 255). */
export function groupBins(bins: ArrayLike<number>, edges: Int32Array, out: Float32Array): Float32Array {
  const bands = Math.min(out.length, edges.length - 1);
  for (let i = 0; i < bands; i++) {
    const from = Math.min(edges[i], bins.length);
    const to = Math.min(edges[i + 1], bins.length);
    if (to <= from) {
      out[i] = from < bins.length ? bins[from] / 255 : 0;
      continue;
    }
    let sum = 0;
    let top = 0;
    for (let bin = from; bin < to; bin++) {
      const value = bins[bin];
      sum += value;
      if (value > top) top = value;
    }
    // Mostly the average, with a share of the strongest bin so that a single clear tone is not washed out by its neighbours.
    out[i] = (0.6 * (sum / (to - from)) + 0.4 * top) / 255;
  }
  return out;
}

/** Readings below this are noise, not music. */
const GATE = 0.07;
/** A band is never judged against a peak smaller than this, so that a quiet passage does not blow up its noise. */
const FLOOR = 0.22;
/** Contrast: the exponent that turns "somewhat loud" into "a little" and keeps only real hits at the top. */
const SHAPE = 1.35;
const ATTACK = 30;
const RELEASE = 5.5;

export class Spectrum implements SpectrumField {
  /** The smoothed bands the scene reads. */
  readonly bands = new Float32Array(SPECTRUM_BANDS);
  version = 0;
  beat = 0;
  energy = 0;
  active = false;

  private readonly peak = new Float32Array(SPECTRUM_BANDS).fill(FLOOR);
  private readonly target = new Float32Array(SPECTRUM_BANDS);
  private bassAverage = 0;
  private sinceBeat = 1;
  private clock = 0;

  /** One reading of the analyser: `raw[i]` is how loud band i is (0 … 1). Each band is judged against its own recent loudest. */
  feed(raw: ArrayLike<number>, dt: number) {
    dt = Math.min(0.1, Math.max(0, dt));
    const decay = Math.exp(-dt * 0.35);
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const value = Math.max(0, (raw[i] ?? 0) - GATE) / (1 - GATE);
      this.peak[i] = Math.max(value, this.peak[i] * decay, FLOOR);
      this.target[i] = Math.pow(clamp01(value / this.peak[i]), SHAPE);
    }
    // A beat is a bass onset: well above what the bass has been lately (the average climbs fast and falls slowly, so a held
    // tone is one beat, not many), and not within a sixth of a second of the last one.
    this.sinceBeat += dt;
    let bass = 0;
    for (let i = 0; i < 4; i++) bass += this.target[i];
    bass /= 4;
    const hit = bass - this.bassAverage > 0.2 && bass > 0.45 && this.sinceBeat > 0.17;
    if (hit) this.sinceBeat = 0;
    this.bassAverage += (bass - this.bassAverage) * (1 - Math.exp(-(bass > this.bassAverage ? 14 : 2) * dt));
    this.follow(dt, hit);
  }

  /**
   * A made-up groove (a kick on every beat, a snare on two and four, a hi-hat between): what the scene dances to when the
   * page cannot read the audio itself. `tempo` is in beats per minute.
   */
  synth(dt: number, tempo = 104) {
    dt = Math.min(0.1, Math.max(0, dt));
    const before = Math.floor((this.clock * tempo) / 60);
    this.clock += dt;
    const beats = (this.clock * tempo) / 60;
    const bar = Math.floor(beats);
    const phase = beats - bar;
    const kick = Math.exp(-phase * 5.5);
    const snare = bar % 2 === 1 ? Math.exp(-phase * 7) : 0;
    const hatPhase = (beats * 2 + 0.5) % 1;
    const hat = Math.exp(-hatPhase * 11);
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const x = i / (SPECTRUM_BANDS - 1);
      const wobble = 0.5 + 0.5 * Math.sin(this.clock * (1.3 + 0.41 * i) + i * 1.9);
      let value: number;
      if (x < 0.25) value = 0.22 * wobble + 0.82 * kick;
      else if (x < 0.6) value = 0.16 + 0.34 * wobble + 0.45 * snare + 0.12 * kick;
      else value = 0.06 + 0.2 * wobble + 0.55 * hat + 0.22 * snare;
      this.target[i] = clamp01(value);
    }
    this.follow(dt, bar !== before);
  }

  /** Nothing plays: every band falls back to rest. */
  release(dt: number) {
    dt = Math.min(0.1, Math.max(0, dt));
    this.target.fill(0);
    this.follow(dt);
  }

  /** A new song: the bands are judged afresh (the old song's loudest no longer sets the scale), but nothing jumps. */
  forget() {
    this.peak.fill(FLOOR);
    this.bassAverage = 0;
    this.sinceBeat = 1;
  }

  /** Back to silence at once (a rebuilt scene). */
  reset() {
    this.bands.fill(0);
    this.target.fill(0);
    this.peak.fill(FLOOR);
    this.beat = 0;
    this.energy = 0;
    this.bassAverage = 0;
    this.sinceBeat = 1;
    if (this.active) this.version++;
    this.active = false;
  }

  at(x: number): number {
    const position = clamp01(x) * (SPECTRUM_BANDS - 1);
    const low = Math.floor(position);
    const high = Math.min(SPECTRUM_BANDS - 1, low + 1);
    return this.bands[low] + (this.bands[high] - this.bands[low]) * (position - low);
  }

  /** Move every band towards its target (up fast, down slowly) and settle the summary values; `hit` starts a new beat. */
  private follow(dt: number, hit = false) {
    let moved = 0;
    let sum = 0;
    let top = 0;
    const up = 1 - Math.exp(-ATTACK * dt);
    const down = 1 - Math.exp(-RELEASE * dt);
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const goal = this.target[i];
      const current = this.bands[i];
      let next = current + (goal - current) * (goal > current ? up : down);
      if (goal < 0.003 && next < 0.003) next = 0;
      moved = Math.max(moved, Math.abs(next - current));
      this.bands[i] = next;
      sum += next;
      if (next > top) top = next;
    }
    this.energy = sum / SPECTRUM_BANDS;
    this.beat *= Math.exp(-dt * 6.5);
    if (this.beat < 0.004) this.beat = 0;
    if (hit) this.beat = 1;
    const was = this.active;
    this.active = top > 0 || this.beat > 0;
    if (moved > 0.0005 || was !== this.active || this.beat > 0) this.version++;
  }
}
