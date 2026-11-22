import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPECTRUM_BANDS, Spectrum, bandEdges, groupBins } from "../../src/spectrum";

const frame = 1 / 60;
const quiet = () => new Float32Array(SPECTRUM_BANDS);
const reading = (fill: (band: number) => number) => Float32Array.from({ length: SPECTRUM_BANDS }, (_, band) => fill(band));
const run = (spectrum: Spectrum, seconds: number, step: (spectrum: Spectrum) => void) => {
  for (let t = 0; t < seconds; t += frame) step(spectrum);
};

describe("spectrum bands", () => {
  it("log-spaced band edges grow strictly, stay inside the analyser, and the lowest bands are single bins", () => {
    for (const [binCount, rate] of [[512, 44100], [512, 48000], [128, 44100]] as const) {
      const edges = bandEdges(SPECTRUM_BANDS, binCount, rate);
      assert.equal(edges.length, SPECTRUM_BANDS + 1);
      for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1], `edge ${i} of ${binCount}/${rate}`);
      assert.ok(edges[0] >= 1);
    }
    const edges = bandEdges(SPECTRUM_BANDS, 512, 44100);
    assert.equal(edges[1] - edges[0], 1);
    const widths = Array.from({ length: SPECTRUM_BANDS }, (_, i) => edges[i + 1] - edges[i]);
    assert.ok(widths[SPECTRUM_BANDS - 1] > widths[0] * 4, "the top bands are much wider than the bottom ones");
    // 14 kHz at 43 Hz per bin is bin 325.
    assert.ok(Math.abs(edges[SPECTRUM_BANDS] - 325) <= 2);
  });

  it("one tone shows up in its own band only; silence and short readings are safe", () => {
    const edges = bandEdges(SPECTRUM_BANDS, 512, 44100);
    const bins = new Uint8Array(512);
    const band = 11;
    for (let bin = edges[band]; bin < edges[band + 1]; bin++) bins[bin] = 255;
    const out = groupBins(bins, edges, new Float32Array(SPECTRUM_BANDS));
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      if (i === band) assert.ok(out[i] > 0.99);
      else assert.equal(out[i], 0);
    }
    assert.deepEqual([...groupBins(new Uint8Array(512), edges, new Float32Array(SPECTRUM_BANDS))], Array(SPECTRUM_BANDS).fill(0));
    const short = groupBins(new Uint8Array(10).fill(200), edges, new Float32Array(SPECTRUM_BANDS));
    assert.ok(short.every((value) => value >= 0 && value <= 1));
  });
});

describe("spectrum smoothing", () => {
  it("a hit jumps up within a few frames and falls back slowly, then settles to exact rest", () => {
    const spectrum = new Spectrum();
    const loud = reading((band) => (band < 4 ? 0.9 : 0));
    for (let i = 0; i < 3; i++) spectrum.feed(loud, frame);
    assert.ok(spectrum.at(0) > 0.6, `bass after three frames: ${spectrum.at(0)}`);
    assert.equal(spectrum.at(1), 0, "treble stays at rest");
    assert.ok(spectrum.active);
    const peak = spectrum.at(0);
    run(spectrum, 0.1, (s) => s.feed(quiet(), frame));
    assert.ok(spectrum.at(0) > peak * 0.4, "after 0.1 s it has not fallen far");
    run(spectrum, 2.5, (s) => s.feed(quiet(), frame));
    assert.equal(spectrum.at(0), 0);
    assert.equal(spectrum.active, false);
  });

  it("each band is judged against its own loudest: quiet treble moves as fully as loud bass", () => {
    const spectrum = new Spectrum();
    run(spectrum, 1.5, (s) => s.feed(reading((band) => (band < 4 ? 0.9 : band > 14 ? 0.3 : 0.1)), frame));
    assert.ok(spectrum.at(0.05) > 0.85, `bass ${spectrum.at(0.05)}`);
    assert.ok(spectrum.at(1) > 0.85, `treble ${spectrum.at(1)}`);
  });

  it("readings under the noise gate do nothing at all", () => {
    const spectrum = new Spectrum();
    run(spectrum, 1, (s) => s.feed(reading(() => 0.06), frame));
    assert.equal(spectrum.active, false);
    assert.equal(spectrum.energy, 0);
    assert.equal(spectrum.version, 0);
  });

  it("a frame of zero length changes nothing, and a huge one counts as a tenth of a second", () => {
    const spectrum = new Spectrum();
    spectrum.feed(reading(() => 0.8), 0);
    assert.equal(spectrum.at(0.5), 0);
    spectrum.feed(reading(() => 0.8), 100);
    assert.ok(spectrum.at(0.5) > 0.9 && spectrum.at(0.5) <= 1);
  });

  it("at() interpolates between bands and clamps outside 0 … 1", () => {
    const spectrum = new Spectrum();
    spectrum.bands[3] = 0.2;
    spectrum.bands[4] = 0.6;
    const x = (3.5 / (SPECTRUM_BANDS - 1));
    assert.ok(Math.abs(spectrum.at(x) - 0.4) < 1e-6);
    spectrum.bands[0] = 0.5;
    spectrum.bands[SPECTRUM_BANDS - 1] = 0.9;
    assert.ok(Math.abs(spectrum.at(-3) - 0.5) < 1e-6);
    assert.ok(Math.abs(spectrum.at(7) - 0.9) < 1e-6);
  });

  it("the version moves while the bands move and stops when they rest", () => {
    const spectrum = new Spectrum();
    spectrum.feed(reading(() => 0.9), frame);
    const first = spectrum.version;
    assert.ok(first > 0);
    run(spectrum, 3, (s) => s.release(frame));
    const rested = spectrum.version;
    run(spectrum, 1, (s) => s.release(frame));
    assert.equal(spectrum.version, rested, "nothing changes once everything is at rest");
    assert.equal(spectrum.active, false);
  });

  it("reset drops everything to silence at once", () => {
    const spectrum = new Spectrum();
    run(spectrum, 0.5, (s) => s.feed(reading(() => 0.9), frame));
    assert.ok(spectrum.active);
    const before = spectrum.version;
    spectrum.reset();
    assert.equal(spectrum.active, false);
    assert.equal(spectrum.energy, 0);
    assert.equal(spectrum.beat, 0);
    assert.equal(spectrum.at(0.5), 0);
    assert.ok(spectrum.version > before, "consumers see the change");
  });
});

describe("beat", () => {
  it("a bass onset sets the beat to one, which then falls away; a second onset right after does not re-trigger", () => {
    const spectrum = new Spectrum();
    run(spectrum, 0.6, (s) => s.feed(quiet(), frame));
    spectrum.feed(reading((band) => (band < 4 ? 0.95 : 0.05)), frame);
    assert.equal(spectrum.beat, 1);
    run(spectrum, 0.5, (s) => s.feed(quiet(), frame));
    assert.ok(spectrum.beat < 0.1);
    // Another hit before the minimum gap is over is ignored: one onset, one beat.
    const second = new Spectrum();
    run(second, 0.6, (s) => s.feed(quiet(), frame));
    second.feed(reading((band) => (band < 4 ? 0.95 : 0)), frame);
    second.feed(quiet(), frame);
    second.beat = 0;
    second.feed(reading((band) => (band < 4 ? 0.95 : 0)), frame);
    assert.equal(second.beat, 0, "within 0.17 s of the previous beat");
  });

  it("steady loud bass is not a beat every frame", () => {
    const spectrum = new Spectrum();
    let beats = 0;
    run(spectrum, 3, (s) => {
      const before = s.beat;
      s.feed(reading((band) => (band < 4 ? 0.9 : 0.4)), frame);
      if (s.beat > before) beats++;
    });
    assert.equal(beats, 1, `${beats} beats in three seconds of a held tone: only its start is a beat`);
  });
});

describe("made-up groove", () => {
  it("has a kick on every beat, bass leading the highs on the kick, and keeps the scene active", () => {
    const spectrum = new Spectrum();
    let kicks = 0;
    let bassOnKick = 0;
    let trebleOnKick = 0;
    run(spectrum, 6, (s) => {
      const before = s.beat;
      s.synth(frame, 120);
      if (s.beat > before + 0.5) {
        kicks++;
        bassOnKick = Math.max(bassOnKick, s.at(0.05));
        trebleOnKick = Math.max(trebleOnKick, s.at(1));
      }
    });
    assert.ok(kicks >= 11 && kicks <= 13, `${kicks} kicks in six seconds at 120 bpm`);
    assert.ok(bassOnKick > 0.3, `bass on the kick ${bassOnKick}`);
    assert.ok(bassOnKick > trebleOnKick, "the kick is a low sound");
    assert.ok(spectrum.active);
  });

  it("dies away after the music stops", () => {
    const spectrum = new Spectrum();
    run(spectrum, 2, (s) => s.synth(frame));
    assert.ok(spectrum.active);
    run(spectrum, 3, (s) => s.release(frame));
    assert.equal(spectrum.active, false);
    assert.equal(spectrum.energy, 0);
  });

  it("every band stays inside 0 … 1", () => {
    const spectrum = new Spectrum();
    run(spectrum, 10, (s) => {
      s.synth(frame, 150);
      for (const value of s.bands) assert.ok(value >= 0 && value <= 1);
      assert.ok(s.beat >= 0 && s.beat <= 1);
    });
  });
});
