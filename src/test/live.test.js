/* ============================================================
   HOW MANY FRAMES, AND WHERE THEY ARE SPENT

   The proposal tells a customer "30 fps". That is a promise about
   the one candidate an invigilator has opened — not about thirty
   tiles at once, which nobody can watch and no campus uplink should
   be asked to carry.

   These tests pin both halves of that, because the temptation when
   somebody asks for "30 fps everywhere" is to raise the wall's rate
   and quietly make the whole product unusable in a real hall.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, gridProfile, focusProfile, FOCUS_MAX_FPS } from '../realtime/live.js';

/* ---------------- the focused candidate ---------------- */

test('a focused candidate can be asked for 30 frames a second', () => {
  assert.equal(FOCUS_MAX_FPS, 30, 'this is the number the proposal commits to');
  assert.equal(focusProfile(30).fps, 30);
});

test('asking for more than 30 is capped rather than obeyed', () => {
  assert.equal(focusProfile(60).fps, 30);
  assert.equal(focusProfile(999).fps, 30);
});

test('asking for nonsense falls back to the default rather than stopping the stream', () => {
  assert.equal(focusProfile(0).fps, PROFILES.focus.fps);
  assert.equal(focusProfile(null).fps, PROFILES.focus.fps);
  assert.equal(focusProfile('abc').fps, PROFILES.focus.fps);
  assert.equal(focusProfile(-5).fps, 1, 'a negative rate floors at one, never zero');
});

test('past 24 fps the picture is narrowed and compressed harder', () => {
  /* Still JPEG over a WebSocket on this path. Thirty full-size
     frames a second of it would be several megabits for one
     candidate, and a hall has one uplink. */
  const at24 = focusProfile(24);
  const at30 = focusProfile(30);
  assert.ok(at30.width <= at24.width, 'width must not grow with the rate');
  assert.ok(at30.quality <= at24.quality, 'quality must not grow with the rate');
});

/* ---------------- the wall ---------------- */

test('a wall full of candidates drops to the floor rate, by design', () => {
  /* Thirty tiles at 30 fps is roughly 90 Mbps into one machine, to
     show something no person can read. */
  assert.equal(gridProfile(30).fps, PROFILES.grid.fps);
  assert.equal(gridProfile(300).fps, PROFILES.grid.fps);
});

test('a near-empty room spends what it has on the few who are there', () => {
  assert.ok(gridProfile(1).fps > PROFILES.grid.fps);
  assert.ok(gridProfile(3).fps > PROFILES.grid.fps);
});

test('the wall rate never exceeds the focus default, whatever the room size', () => {
  for (const n of [0, 1, 2, 5, 12, 30, 90, 300]) {
    const { fps } = gridProfile(n);
    assert.ok(fps >= PROFILES.grid.fps, `floor broken at n=${n}`);
    assert.ok(fps <= PROFILES.focus.fps, `ceiling broken at n=${n}`);
  }
});

test('the wall rate falls as the room fills, never rises', () => {
  let previous = Infinity;
  for (const n of [1, 2, 3, 4, 6, 8, 12, 16, 24, 30, 60]) {
    const { fps } = gridProfile(n);
    assert.ok(fps <= previous, `rate rose going from a smaller room to ${n}`);
    previous = fps;
  }
});

test('an empty room is treated as one candidate rather than dividing by zero', () => {
  assert.ok(Number.isFinite(gridProfile(0).fps));
  assert.equal(gridProfile(0).fps, gridProfile(1).fps);
});

/* ---------------- the bandwidth this implies ---------------- */

test('a full wall stays within a campus uplink', () => {
  /* The figure in the comments is ~12 KB per frame-second per tile at
     the floor profile. Thirty tiles at 1.5 fps is about 2.9 Mbps; the
     test guards the ORDER of magnitude, so a change that multiplies
     it by twenty fails here rather than in a hall. */
  const perTileKbps = (p) => (p.width / 240) * (p.quality / 0.45) * p.fps * 8 * 8;
  const wall = perTileKbps(gridProfile(30)) * 30;
  assert.ok(wall < 10_000, `a full wall would need ${Math.round(wall)} kbps`);
});
