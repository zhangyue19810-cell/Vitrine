// Pure geometry checks for the Möbius archive ring used by src/app/views/browse.ts.
// Run with: node scripts/check-browse-mobius.mjs
import assert from "node:assert/strict";

const R = 11;
const W = 4.8;
const point = (u, v) => {
  const r = R + v * Math.cos(u / 2);
  return [r * Math.cos(u), v * Math.sin(u / 2), r * Math.sin(u)];
};
const close = (a, b, epsilon = 1e-9) => a.every((value, index) => Math.abs(value - b[index]) < epsilon);
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const frame = (u) => {
  const tangentU = normalize([-Math.sin(u), 0, Math.cos(u)]);
  const tangentV = normalize([Math.cos(u / 2) * Math.cos(u), Math.sin(u / 2), Math.cos(u / 2) * Math.sin(u)]);
  return { tangentU, tangentV, normal: normalize(cross(tangentU, tangentV)) };
};

// The seam identifies (0, v) with (2pi, -v) without a spatial crack.
for (const v of [-W / 2, 0, W / 2]) {
  assert.ok(close(point(0, v), point(Math.PI * 2, -v)), `seam mismatch at v=${v}`);
}

// A single boundary circuit requires two parameter circuits.
assert.ok(close(point(0, W / 2), point(Math.PI * 4, W / 2)), "boundary does not close after two turns");

// Centerline is a closed loop.
assert.ok(close(point(0, 0), point(Math.PI * 2, 0)), "centerline does not close");

// One centerline circuit reverses the local normal; two restore it.
const start = frame(0);
const full = frame(Math.PI * 2);
assert.ok(close(start.normal, full.normal.map((value) => -value), 1e-9), "one circuit unexpectedly restored the normal");
const twice = frame(Math.PI * 4);
assert.ok(close(start.normal, twice.normal, 1e-9), "two circuits did not restore the normal");

// The card basis stays orthonormal, including at the seam side.
for (const u of [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI * 2]) {
  const { tangentU, tangentV, normal } = frame(u);
  assert.ok(Math.abs(tangentU[0] * tangentV[0] + tangentU[1] * tangentV[1] + tangentU[2] * tangentV[2]) < 1e-9, `non-orthogonal frame at ${u}`);
  assert.ok(close(normal, normalize(cross(tangentU, tangentV)), 1e-9), `bad normal at ${u}`);
}

console.log("Möbius archive geometry: PASS (seam, boundary, closed centerline, reversed normal, orthonormal frames)");
