import {
  BLOCKS_X,
  BLOCKS_Y,
  BLOCK_W,
  BLOCK_H,
  ROAD_W,
  ROAD_H,
  STRIDE_X,
  STRIDE_Y,
  blockOrigin,
} from "./city.js";

const OUTER_W = BLOCK_W + 2;
const OUTER_H = BLOCK_H + 2;
/**
 * Sidewalk ring inset from the outer curb cell.
 * 1.5 sits on the second sidewalk cell so walkers clear streetlamp poles.
 */
const CURB = 1.5;

/** Target gap along the block perimeter (map cells). */
const SPACING_NEAR = 3.2;
const SPACING_FAR = 6.5;
const MAX_PEOPLE = 1200;
const VIEW_PAD = 20;
const MAX_DT = 0.05;
/** Sidewalk voxels are centered at y=0.5 with height 1, so the top is at 1. */
const SIDEWALK_TOP = 1.0;

/** Perimeter rectangle through inset sidewalk cell centers. */
const PERIM_W = OUTER_W - CURB * 2;
const PERIM_H = OUTER_H - CURB * 2;
const PERIM_LEN = 2 * (PERIM_W + PERIM_H);

const WALK_SPEEDS = [1.35, 1.55, 1.75, 1.95];

const PERSON_COLORS = [
  [0xe0 / 255, 0x7a / 255, 0x58 / 255],
  [0x5a / 255, 0x8a / 255, 0xd0 / 255],
  [0x4a / 255, 0x9a / 255, 0x68 / 255],
  [0xa0 / 255, 0x60 / 255, 0xb0 / 255],
  [0xc0 / 255, 0x90 / 255, 0x48 / 255],
  [0xd0 / 255, 0xd0 / 255, 0xd4 / 255],
  [0xc0 / 255, 0x50 / 255, 0x50 / 255],
  [0x48 / 255, 0xa8 / 255, 0xa8 / 255],
];

/**
 * @typedef {{
 *   bx: number,
 *   by: number,
 *   along: number,
 *   dir: number,
 *   speed: number,
 *   seed: number,
 *   dead?: boolean,
 * }} Person
 */

/** @type {Person[]} */
const people = [];
let lastTimeSec = -1;
let nextSeed = 1;

function hash01(n) {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function personColor(seed) {
  return PERSON_COLORS[Math.floor(hash01(seed) * PERSON_COLORS.length)];
}

function walkSpeed(seed) {
  return WALK_SPEEDS[Math.floor(hash01(seed + 17) * WALK_SPEEDS.length)];
}

/**
 * Map perimeter distance to curb sidewalk position.
 * Clockwise from the northwest curb cell: east, south, west, north.
 */
function perimeterPos(bx, by, along) {
  const o = blockOrigin(bx, by);
  let t = ((along % PERIM_LEN) + PERIM_LEN) % PERIM_LEN;

  if (t < PERIM_W) {
    return { x: o.x + CURB + t, z: o.y + CURB };
  }
  t -= PERIM_W;
  if (t < PERIM_H) {
    return { x: o.x + OUTER_W - CURB, z: o.y + CURB + t };
  }
  t -= PERIM_H;
  if (t < PERIM_W) {
    return { x: o.x + OUTER_W - CURB - t, z: o.y + OUTER_H - CURB };
  }
  t -= PERIM_W;
  return { x: o.x + CURB, z: o.y + OUTER_H - CURB - t };
}

function spawnPerson(bx, by, along, seed) {
  const dir = hash01(seed + 31) < 0.5 ? 1 : -1;
  return {
    bx,
    by,
    along,
    dir,
    speed: walkSpeed(seed),
    seed,
  };
}

function ensureBlockPeople(bx, by, spacing) {
  if (people.length >= MAX_PEOPLE) return;

  const existing = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (p.bx === bx && p.by === by) existing.push(p);
  }

  let alive = 0;
  for (let i = 0; i < existing.length; i++) {
    if (!existing[i].dead) alive++;
  }

  const want = Math.max(8, Math.ceil(PERIM_LEN / spacing));
  if (alive >= want || people.length >= MAX_PEOPLE) return;

  const phase = hash01(0x30000 + bx * 131 + by * 17) * spacing;
  for (
    let along = phase;
    along < PERIM_LEN && alive < want && people.length < MAX_PEOPLE;
    along += spacing
  ) {
    let near = false;
    for (let i = 0; i < existing.length; i++) {
      const p = existing[i];
      if (p.dead) continue;
      let d = Math.abs(p.along - along);
      if (d > PERIM_LEN * 0.5) d = PERIM_LEN - d;
      if (d < spacing * 0.45) {
        near = true;
        break;
      }
    }
    if (near) continue;
    people.push(spawnPerson(bx, by, along, nextSeed++));
    alive++;
  }
}

function compactPeople() {
  let w = 0;
  for (let i = 0; i < people.length; i++) {
    if (!people[i].dead) people[w++] = people[i];
  }
  people.length = w;
}

function updatePeople(dt) {
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    p.along += p.speed * p.dir * dt;
    // Keep along in a stable range so ensure/spawn distance checks stay sensible.
    if (p.along >= PERIM_LEN || p.along < 0) {
      p.along = ((p.along % PERIM_LEN) + PERIM_LEN) % PERIM_LEN;
    }
  }
}

function pushPerson(data, count, maxCount, x, z, color, pushBox) {
  const bodyW = 0.32;
  const bodyD = 0.26;
  const bodyH = 0.9;
  const feet = SIDEWALK_TOP + 0.02;

  return pushBox(
    data,
    count,
    x,
    feet + bodyH * 0.5,
    z,
    bodyW,
    bodyH,
    bodyD,
    color
  );
}

function paintPeople(data, count, maxCount, x0, z0, x1, z1, pushBox) {
  for (let i = 0; i < people.length && count < maxCount; i++) {
    const p = people[i];
    const pos = perimeterPos(p.bx, p.by, p.along);
    if (pos.x < x0 - 1 || pos.x > x1 + 1 || pos.z < z0 - 1 || pos.z > z1 + 1) {
      continue;
    }
    count = pushPerson(
      data,
      count,
      maxCount,
      pos.x,
      pos.z,
      personColor(p.seed),
      pushBox
    );
  }
  return count;
}

/**
 * Simulate pedestrians walking the curb sidewalk around each visible block.
 * @returns {number} updated instance count
 */
export function paintCrowd(timeSec, data, count, maxCount, x0, z0, x1, z1, pushBox) {
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const spacing = span > 140 ? SPACING_FAR : SPACING_NEAR;

  let dt = 0;
  if (lastTimeSec >= 0) dt = Math.min(MAX_DT, Math.max(0, timeSec - lastTimeSec));
  lastTimeSec = timeSec;

  const bx0 = Math.max(0, Math.floor((x0 - VIEW_PAD - ROAD_W) / STRIDE_X));
  const bx1 = Math.min(BLOCKS_X - 1, Math.floor((x1 + VIEW_PAD - ROAD_W) / STRIDE_X));
  const row0 = Math.max(0, Math.floor((z0 - VIEW_PAD - ROAD_H) / STRIDE_Y));
  const row1 = Math.min(BLOCKS_Y - 1, Math.floor((z1 + VIEW_PAD - ROAD_H) / STRIDE_Y));

  const keep = new Set();
  for (let row = row0; row <= row1; row++) {
    const by = BLOCKS_Y - 1 - row;
    for (let bx = bx0; bx <= bx1; bx++) {
      const o = blockOrigin(bx, by);
      if (
        o.x + OUTER_W < x0 - VIEW_PAD ||
        o.x > x1 + VIEW_PAD ||
        o.y + OUTER_H < z0 - VIEW_PAD ||
        o.y > z1 + VIEW_PAD
      ) {
        continue;
      }
      keep.add(`${bx}:${by}`);
      ensureBlockPeople(bx, by, spacing);
    }
  }

  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!keep.has(`${p.bx}:${p.by}`)) p.dead = true;
  }
  compactPeople();

  if (dt > 0) updatePeople(dt);

  return paintPeople(data, count, maxCount, x0, z0, x1, z1, pushBox);
}
