import assert from "node:assert/strict";
import test from "node:test";
import { SHADOW, TABLE, TableBuilder, buildDeflectionTable, columnOf, doppler, impactOf, orbitSpeed, sampleRay, toHalf, totalAngle, traceRay } from "../../src/space/geodesic";

const near = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (±${eps})`);

test("the shadow is 3√3/2 horizon radii across", () => {
  near(SHADOW, 2.598076, 1e-6);
});

test("rays below the critical impact parameter fall in, those above get away", () => {
  for (const b of [0.2, 1, 2, 2.5, 2.58]) assert.equal(traceRay(b, 2000, 8 * Math.PI).fell, true, `b = ${b}`);
  for (const b of [2.62, 2.7, 3, 4, 8, 20]) assert.equal(traceRay(b, 2000, 8 * Math.PI).fell, false, `b = ${b}`);
});

test("far from the hole the deflection is 2/b plus the second-order term", () => {
  for (const b of [30, 60]) {
    const deflection = traceRay(b, 6000, 4 * Math.PI, 4).end - Math.PI;
    const expected = 2 / b + (15 * Math.PI) / 16 / (b * b);
    near(deflection, expected, expected * 0.04);
  }
});

test("a ray just outside the shadow goes more than once round before it leaves", () => {
  assert.ok(totalAngle(SHADOW + 0.01, 10 * Math.PI) > 2 * Math.PI + 0.5);
  assert.ok(totalAngle(SHADOW + 0.3, 10 * Math.PI) > Math.PI + 1);
  // … and the nearer to the shadow, the further round.
  assert.ok(totalAngle(SHADOW + 0.003, 14 * Math.PI) > totalAngle(SHADOW + 0.05, 14 * Math.PI));
});

test("the path obeys the first integral (du/dφ)² = 1/b² − u²(1 − u)", () => {
  const b = 4;
  const ray = traceRay(b, 2500, 3 * Math.PI, 3);
  for (let i = 1; i < 1500; i += 100) {
    const u = ray.u[i];
    const du = ray.du[i];
    if (u >= 1 || u <= 0) continue;
    near(du * du, 1 / (b * b) - u * u * (1 - u), 2e-4);
  }
});

test("a ray from far away starts at u = 0 with slope 1/b and a straight one has u = sin φ / b", () => {
  const b = 50;
  const ray = traceRay(b, 800, Math.PI);
  near(ray.u[0], 0, 1e-12);
  near(ray.du[0], 1 / b, 1e-12);
  const half = sampleRay(ray, Math.PI / 2);
  near(half.u, 1 / b, (1 / b) * 0.06);
});

test("the table: columns map to impact parameters and back", () => {
  for (const x of [0, 1, 17, 400, 1000, TABLE.width - 1]) near(columnOf(impactOf(x)), x, 1e-6);
  near(impactOf(0), 0, 1e-12);
  near(impactOf(TABLE.width - 1), TABLE.bMax, 1e-9);
});

test("the table holds what the rays do", () => {
  const table = buildDeflectionTable(256, 256, 20, 1.6, TABLE.phiMax);
  const at = (x: number, y: number) => ({ u: table.data[(y * table.width + x) * 2], du: table.data[(y * table.width + x) * 2 + 1] });
  const last = table.height - 1;
  // The middle of the picture fell in at once, and stays fallen.
  assert.equal(at(0, last).u, 1);
  assert.equal(at(1, 40).u, 1);
  // A ray far from the hole that passes at φ = π/2 is 1/b away (u = 1/b).
  const x = table.width - 1;
  const row = Math.round((Math.PI / 2 / TABLE.phiMax) * last);
  near(at(x, row).u, 1 / TABLE.bMax, 0.006);
  // Every entry is a plausible 1/r.
  for (let i = 0; i < table.data.length; i += 2) assert.ok(table.data[i] >= 0 && table.data[i] <= 1, `u at ${i / 2}`);
  // A ray that got away has u = 0 at the end; one that fell has u = 1 there.
  const columnOfB = (b: number) => Math.round(columnOf(b, table.width));
  assert.equal(at(columnOfB(8), last).u, 0);
  assert.equal(at(columnOfB(2), last).u, 1);
});

test("the Doppler factor: a spot coming towards us is brighter and bluer, one going away dimmer", () => {
  near(doppler(0.5, [0, 0, 1], [0, 0, 1]), Math.sqrt(3), 1e-9);
  near(doppler(0.5, [0, 0, -1], [0, 0, 1]), 1 / Math.sqrt(3), 1e-9);
  near(doppler(0.5, [1, 0, 0], [0, 0, 1]), Math.sqrt(1 - 0.25), 1e-9);
  near(doppler(0, [0, 0, 1], [0, 0, 1]), 1, 1e-12);
});

test("circular orbits: 0.41 c at the innermost stable one (3 horizon radii), slower further out", () => {
  near(orbitSpeed(3), Math.sqrt(1 / 6), 1e-12);
  assert.ok(orbitSpeed(6) < orbitSpeed(3));
});

test("half-precision conversion matches the IEEE bit patterns", () => {
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(0.5), 0x3800);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(0.0009765625), 0x1400);
  // 0.1 rounds to the nearest half: 0x2e66 (0.0999755859375).
  assert.equal(toHalf(0.1), 0x2e66);
  // A rounding carry goes into the exponent: just under 2 rounds up to 2.
  assert.equal(toHalf(1.99999), 0x4000);
});

test("the table can be built a few columns at a time, with the same result", () => {
  const whole = buildDeflectionTable(64, 96, 20, 1.6, TABLE.phiMax);
  const builder = new TableBuilder(64, 96, 20, 1.6, TABLE.phiMax);
  let calls = 0;
  let clock = 0;
  // A clock that moves 1 ms per read, so a 3 ms budget traces about 3 columns a call.
  while (!builder.step(3, () => clock++)) calls++;
  assert.ok(calls > 5, `built in ${calls + 1} calls`);
  assert.equal(builder.progress, 1);
  assert.deepEqual(Array.from(builder.table.data), Array.from(whole.data));
  assert.deepEqual(Array.from(builder.table.half), Array.from(whole.half));
});
