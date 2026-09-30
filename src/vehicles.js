import {
  BLOCKS_X,
  BLOCKS_Y,
  ROAD_W,
  ROAD_H,
  STRIDE_X,
  STRIDE_Y,
  avenueX,
  streetY,
} from "./city.js";

/** Target gap between car centers along a lane (map cells). */
const SPACING_NEAR = 13.5;
const SPACING_FAR = 27;
/** Soft cap so a wide zoom does not explode instance count. */
const MAX_CARS = 300;
const VIEW_PAD = 24;
const STOP_MARGIN = 2.0;
const MIN_GAP = 3.2;
/** Approach distance (in seconds of cruise) to start easing for a red light / lead car. */
const BRAKE_TIME = 2.2;
const MAX_DT = 0.05;

/** Seconds per full avenue→street cycle at an intersection. */
const LIGHT_CYCLE = 16;
const LIGHT_GREEN = 5.5;
const LIGHT_YELLOW = 1.5;
const LIGHT_ALL_RED = 1.5;

const CAR_COLORS = [
  [0x9a / 255, 0x9a / 255, 0x9c / 255],
  [0x7e / 255, 0x7e / 255, 0x82 / 255],
  [0x5c / 255, 0x5c / 255, 0x60 / 255],
  [0x3e / 255, 0x3e / 255, 0x42 / 255],
  [0xb0 / 255, 0xb0 / 255, 0xb4 / 255],
  [0x6a / 255, 0x6a / 255, 0x6e / 255],
  [0x4a / 255, 0x4a / 255, 0x4e / 255],
  [0x8c / 255, 0x8c / 255, 0x90 / 255],
];

const POLE_COLOR = [0x2a / 255, 0x2c / 255, 0x32 / 255];
const HOUSING_COLOR = [0x14 / 255, 0x14 / 255, 0x18 / 255];
const LAMP_RED = [1.0, 0.18, 0.12];
const LAMP_YELLOW = [1.0, 0.78, 0.12];
const LAMP_GREEN = [0.15, 0.95, 0.35];
const LAMP_DIM = [0.12, 0.12, 0.12];

/** Colored pool under each lit traffic signal head. */
const SIGNAL_LIGHT_RADIUS = 7;
const SIGNAL_LIGHT_INTENSITY = 0.85;

/** Warm pool under/near each car (kept tight so wet streaks don't ghost). */
const HEADLIGHT_COLOR = [1.0, 0.92, 0.72];
const HEADLIGHT_RADIUS = 2.4;
const HEADLIGHT_INTENSITY = 0.38;
const HEADLIGHT_BEAM = 0.55;

/** Dim red pool near the rear of each car. */
const TAILLIGHT_COLOR = [1.0, 0.12, 0.08];
const TAILLIGHT_RADIUS = 1.8;
const TAILLIGHT_INTENSITY = 0.28;
const TAILLIGHT_BEAM = 0.4;

/** Lane t-values within a road: two each direction. */
const LANES = [
  { t: 0.18, dir: 1, speed: 9 },
  { t: 0.36, dir: 1, speed: 11 },
  { t: 0.64, dir: -1, speed: 10 },
  { t: 0.82, dir: -1, speed: 12 },
];

/**
 * @typedef {{
 *   alongX: boolean,
 *   road: number,
 *   lane: number,
 *   along: number,
 *   speed: number,
 *   seed: number,
 *   fixed: number,
 *   dead?: boolean,
 * }} Car
 */

/** @type {Car[]} */
const cars = [];
let lastTimeSec = -1;
let nextSeed = 1;

function hash01(n) {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function carColor(seed) {
  return CAR_COLORS[Math.floor(hash01(seed) * CAR_COLORS.length)];
}

/** Desync neighboring lights so the whole grid does not flip at once. */
function lightOffset(ave, street) {
  return hash01(Math.imul(ave + 3, 747796405) ^ Math.imul(street + 7, 353342299)) * 5;
}

/**
 * Two-phase signal: avenues (NS) then streets (EW), with yellow + all-red clearance.
 * Only one axis may enter the box at a time.
 */
function lightState(timeSec, ave, street) {
  const t = (timeSec + lightOffset(ave, street)) % LIGHT_CYCLE;
  const aYellow1 = LIGHT_GREEN + LIGHT_YELLOW;
  const clear1 = aYellow1 + LIGHT_ALL_RED;
  const sGreen1 = clear1 + LIGHT_GREEN;
  const sYellow1 = sGreen1 + LIGHT_YELLOW;

  const avenueGreen = t < LIGHT_GREEN;
  const avenueYellow = t >= LIGHT_GREEN && t < aYellow1;
  const streetGreen = t >= clear1 && t < sGreen1;
  const streetYellow = t >= sGreen1 && t < sYellow1;

  return {
    avenueGo: avenueGreen || avenueYellow,
    streetGo: streetGreen || streetYellow,
    avenueYellow,
    streetYellow,
  };
}

/** Solid green only — yellow/red holders stay put unless already in the box. */
function axisMayEnter(timeSec, ave, street, alongX) {
  const state = lightState(timeSec, ave, street);
  if (alongX) return state.streetGo && !state.streetYellow;
  return state.avenueGo && !state.avenueYellow;
}

/** True when `along` sits on crossing pavement (where the other axis also drives). */
function onCrossingPavement(alongX, along, ave, street) {
  if (alongX) {
    const ax = avenueX(ave);
    return along > ax && along < ax + ROAD_W;
  }
  const zy = streetY(street);
  return along > zy && along < zy + ROAD_H;
}

function laneFixed(alongX, road, lane) {
  if (alongX) return streetY(road) + ROAD_H * LANES[lane].t;
  return avenueX(road) + ROAD_W * LANES[lane].t;
}

/**
 * Next intersection this car will hit or is clearing.
 * @returns {{ ave: number, street: number, stop: number } | null}
 */
function nextCrossing(car) {
  const dir = LANES[car.lane].dir;

  if (car.alongX) {
    const street = car.road;
    let ave;
    if (dir > 0) {
      ave = Math.floor((car.along + STOP_MARGIN) / STRIDE_X);
      ave = Math.max(0, Math.min(BLOCKS_X, ave));
      while (ave <= BLOCKS_X && car.along >= avenueX(ave) + ROAD_W + STOP_MARGIN) ave++;
    } else {
      ave = Math.ceil((car.along - STOP_MARGIN) / STRIDE_X);
      ave = Math.max(0, Math.min(BLOCKS_X, ave));
      while (ave >= 0 && car.along <= avenueX(ave) - STOP_MARGIN) ave--;
    }
    if (ave < 0 || ave > BLOCKS_X) return null;
    const ax = avenueX(ave);
    return {
      ave,
      street,
      stop: dir > 0 ? ax - STOP_MARGIN : ax + ROAD_W + STOP_MARGIN,
    };
  }

  const ave = car.road;
  // streetY(s) === (BLOCKS_Y - s) * STRIDE_Y
  let street;
  if (dir > 0) {
    street = Math.ceil(BLOCKS_Y - (car.along + STOP_MARGIN) / STRIDE_Y);
    street = Math.max(0, Math.min(BLOCKS_Y, street));
    while (street >= 0 && car.along >= streetY(street) + ROAD_H + STOP_MARGIN) street--;
  } else {
    street = Math.floor(BLOCKS_Y - (car.along - STOP_MARGIN) / STRIDE_Y);
    street = Math.max(0, Math.min(BLOCKS_Y, street));
    while (street <= BLOCKS_Y && car.along <= streetY(street) - STOP_MARGIN) street++;
  }
  if (street < 0 || street > BLOCKS_Y) return null;
  const zy = streetY(street);
  return {
    ave,
    street,
    stop: dir > 0 ? zy - STOP_MARGIN : zy + ROAD_H + STOP_MARGIN,
  };
}

/** One wedge body (shader-tapered); shape 1/+X 2/-X 3/+Z 4/-Z = nose direction. */
function pushCar(data, count, maxCount, x, z, alongX, dir, color, pushBox) {
  const bodyL = 2.4;
  const bodyW = 1.05;
  const bodyH = 0.7;
  const ground = 0.04;
  const sx = alongX ? bodyL : bodyW;
  const sz = alongX ? bodyW : bodyL;
  const shape = alongX ? (dir > 0 ? 1 : 2) : dir > 0 ? 3 : 4;

  count = pushBox(
    data,
    count,
    x,
    ground + bodyH * 0.5,
    z,
    sx,
    bodyH,
    sz,
    color,
    0,
    0,
    shape
  );
  if (count >= maxCount) return count;

  // Sit just outside the body so emissive faces don't z-fight the chassis.
  const hlDepth = 0.1;
  const hlSize = 0.16;
  const front = (bodyL * 0.5 + hlDepth * 0.5) * dir;
  const back = -(bodyL * 0.5 + hlDepth * 0.5) * dir;
  const side = bodyW * 0.28;
  const hy = ground + bodyH * 0.28 * 0.55;
  const ty = ground + bodyH * 0.55;
  if (alongX) {
    count = pushBox(
      data, count, x + front, hy, z - side, hlDepth, hlSize, hlSize, HEADLIGHT_COLOR, 1
    );
    if (count >= maxCount) return count;
    count = pushBox(
      data, count, x + front, hy, z + side, hlDepth, hlSize, hlSize, HEADLIGHT_COLOR, 1
    );
    if (count >= maxCount) return count;
    count = pushBox(
      data, count, x + back, ty, z - side, hlDepth, hlSize, hlSize, TAILLIGHT_COLOR, 1
    );
    if (count >= maxCount) return count;
    return pushBox(
      data, count, x + back, ty, z + side, hlDepth, hlSize, hlSize, TAILLIGHT_COLOR, 1
    );
  }
  count = pushBox(
    data, count, x - side, hy, z + front, hlSize, hlSize, hlDepth, HEADLIGHT_COLOR, 1
  );
  if (count >= maxCount) return count;
  count = pushBox(
    data, count, x + side, hy, z + front, hlSize, hlSize, hlDepth, HEADLIGHT_COLOR, 1
  );
  if (count >= maxCount) return count;
  count = pushBox(
    data, count, x - side, ty, z + back, hlSize, hlSize, hlDepth, TAILLIGHT_COLOR, 1
  );
  if (count >= maxCount) return count;
  return pushBox(
    data, count, x + side, ty, z + back, hlSize, hlSize, hlDepth, TAILLIGHT_COLOR, 1
  );
}

/**
 * Stamp short-range pools ahead/behind each car onto the tile lightmap.
 * Uses last-frame positions (one-frame lag is invisible at this scale).
 * @param {import("./lighting.js").TileLightmap} lightmap
 */
export function stampCarLights(lightmap) {
  const x0 = lightmap.originX;
  const z0 = lightmap.originZ;
  const x1 = x0 + lightmap.w;
  const z1 = z0 + lightmap.h;
  const pad = Math.max(
    HEADLIGHT_RADIUS + HEADLIGHT_BEAM,
    TAILLIGHT_RADIUS + TAILLIGHT_BEAM
  );

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (car.dead) continue;
    const dir = LANES[car.lane].dir;
    const x = car.alongX ? car.along : car.fixed;
    const z = car.alongX ? car.fixed : car.along;
    if (x < x0 - pad || x > x1 + pad || z < z0 - pad || z > z1 + pad) continue;

    const hx = car.alongX ? x + dir * HEADLIGHT_BEAM : x;
    const hz = car.alongX ? z : z + dir * HEADLIGHT_BEAM;
    lightmap.stampLamp(
      hx,
      hz,
      HEADLIGHT_RADIUS,
      HEADLIGHT_COLOR,
      HEADLIGHT_INTENSITY
    );

    const tx = car.alongX ? x - dir * TAILLIGHT_BEAM : x;
    const tz = car.alongX ? z : z - dir * TAILLIGHT_BEAM;
    lightmap.stampLamp(
      tx,
      tz,
      TAILLIGHT_RADIUS,
      TAILLIGHT_COLOR,
      TAILLIGHT_INTENSITY
    );
  }
}

function paintSignalHead(data, count, maxCount, x, y, z, mode, pushBox) {
  // mode: "red" | "yellow" | "green"
  count = pushBox(data, count, x, y, z, 0.45, 1.2, 0.45, HOUSING_COLOR);
  if (count >= maxCount) return count;

  const red = mode === "red" ? LAMP_RED : LAMP_DIM;
  const yellow = mode === "yellow" ? LAMP_YELLOW : LAMP_DIM;
  const green = mode === "green" ? LAMP_GREEN : LAMP_DIM;

  count = pushBox(data, count, x, y + 0.38, z, 0.3, 0.28, 0.3, red, mode === "red" ? 1 : 0);
  if (count >= maxCount) return count;
  count = pushBox(
    data,
    count,
    x,
    y,
    z,
    0.3,
    0.28,
    0.3,
    yellow,
    mode === "yellow" ? 1 : 0
  );
  if (count >= maxCount) return count;
  return pushBox(
    data,
    count,
    x,
    y - 0.38,
    z,
    0.3,
    0.28,
    0.3,
    green,
    mode === "green" ? 1 : 0
  );
}

function signalMode(go, yellow) {
  if (!go) return "red";
  if (yellow) return "yellow";
  return "green";
}

function signalColor(mode) {
  if (mode === "yellow") return LAMP_YELLOW;
  if (mode === "green") return LAMP_GREEN;
  return LAMP_RED;
}

/**
 * Stamp red/yellow/green pools at each lit signal head in the lightmap rect.
 * @param {import("./lighting.js").TileLightmap} lightmap
 * @param {number} timeSec
 */
export function stampSignalLights(lightmap, timeSec) {
  const x0 = lightmap.originX;
  const z0 = lightmap.originZ;
  const x1 = x0 + lightmap.w;
  const z1 = z0 + lightmap.h;
  const pad = SIGNAL_LIGHT_RADIUS;

  const ave0 = Math.max(0, Math.floor((x0 - pad - ROAD_W) / STRIDE_X));
  const ave1 = Math.min(BLOCKS_X, Math.floor((x1 + pad) / STRIDE_X) + 1);
  const s0 = Math.max(0, Math.floor((z0 - pad - ROAD_H) / STRIDE_Y));
  const s1 = Math.min(BLOCKS_Y, Math.floor((z1 + pad) / STRIDE_Y) + 1);

  for (let s = s0; s <= s1; s++) {
    const street = BLOCKS_Y - s;
    const zy = streetY(street);
    if (zy + ROAD_H < z0 - pad || zy > z1 + pad) continue;
    for (let ave = ave0; ave <= ave1; ave++) {
      const ax = avenueX(ave);
      if (ax + ROAD_W < x0 - pad || ax > x1 + pad) continue;

      const state = lightState(timeSec, ave, street);
      const aveColor = signalColor(signalMode(state.avenueGo, state.avenueYellow));
      const streetColor = signalColor(signalMode(state.streetGo, state.streetYellow));
      const inset = 0.7;

      const corners = [
        { x: ax + inset, z: zy + inset },
        { x: ax + ROAD_W - inset, z: zy + inset },
        { x: ax + inset, z: zy + ROAD_H - inset },
        { x: ax + ROAD_W - inset, z: zy + ROAD_H - inset },
      ];

      for (let c = 0; c < corners.length; c++) {
        const p = corners[c];
        // Avenue-facing head (offset along Z).
        lightmap.stampLamp(
          p.x,
          p.z - 0.3,
          SIGNAL_LIGHT_RADIUS,
          aveColor,
          SIGNAL_LIGHT_INTENSITY
        );
        // Street-facing head (offset along X).
        lightmap.stampLamp(
          p.x - 0.3,
          p.z,
          SIGNAL_LIGHT_RADIUS,
          streetColor,
          SIGNAL_LIGHT_INTENSITY
        );
      }
    }
  }
}

function paintIntersectionLights(data, count, maxCount, timeSec, x0, z0, x1, z1, pushBox) {
  const ave0 = Math.max(0, Math.floor((x0 - ROAD_W) / STRIDE_X));
  const ave1 = Math.min(BLOCKS_X, Math.floor(x1 / STRIDE_X) + 1);
  const s0 = Math.max(0, Math.floor((z0 - ROAD_H) / STRIDE_Y));
  const s1 = Math.min(BLOCKS_Y, Math.floor(z1 / STRIDE_Y) + 1);

  for (let s = s0; s <= s1 && count < maxCount; s++) {
    const street = BLOCKS_Y - s;
    const zy = streetY(street);
    if (zy + ROAD_H < z0 || zy > z1) continue;
    for (let ave = ave0; ave <= ave1 && count < maxCount; ave++) {
      const ax = avenueX(ave);
      if (ax + ROAD_W < x0 || ax > x1) continue;

      const state = lightState(timeSec, ave, street);
      const aveMode = signalMode(state.avenueGo, state.avenueYellow);
      const streetMode = signalMode(state.streetGo, state.streetYellow);
      const inset = 0.7;
      const poleH = 4.2;
      const headY = poleH + 0.35;

      const corners = [
        { x: ax + inset, z: zy + inset },
        { x: ax + ROAD_W - inset, z: zy + inset },
        { x: ax + inset, z: zy + ROAD_H - inset },
        { x: ax + ROAD_W - inset, z: zy + ROAD_H - inset },
      ];

      for (let c = 0; c < corners.length && count < maxCount; c++) {
        const p = corners[c];
        count = pushBox(data, count, p.x, poleH * 0.5, p.z, 0.18, poleH, 0.18, POLE_COLOR);
        if (count >= maxCount) break;
        // Avenue-facing head (offset along Z).
        count = paintSignalHead(
          data,
          count,
          maxCount,
          p.x,
          headY,
          p.z - 0.3,
          aveMode,
          pushBox
        );
        if (count >= maxCount) break;
        // Street-facing head (offset along X).
        count = paintSignalHead(
          data,
          count,
          maxCount,
          p.x - 0.3,
          headY,
          p.z,
          streetMode,
          pushBox
        );
      }
    }
  }
  return count;
}

function spawnCar(alongX, road, lane, along, seed) {
  return {
    alongX,
    road,
    lane,
    along,
    speed: LANES[lane].speed,
    seed,
    fixed: laneFixed(alongX, road, lane),
  };
}

/** Skip spawn points on intersection pavement so cars don't pop into the box. */
function spawnBlocked(alongX, along) {
  if (alongX) {
    let ave = Math.floor(along / STRIDE_X);
    ave = Math.max(0, Math.min(BLOCKS_X, ave));
    const ax = avenueX(ave);
    return along > ax - STOP_MARGIN && along < ax + ROAD_W + STOP_MARGIN;
  }
  let street = Math.round(BLOCKS_Y - along / STRIDE_Y);
  street = Math.max(0, Math.min(BLOCKS_Y, street));
  const zy = streetY(street);
  return along > zy - STOP_MARGIN && along < zy + ROAD_H + STOP_MARGIN;
}

function ensureLaneCars(alongX, road, lane, a0, a1, spacing) {
  if (cars.length >= MAX_CARS) return;

  const fixed = laneFixed(alongX, road, lane);
  const existing = [];
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (car.alongX === alongX && car.road === road && car.lane === lane) {
      existing.push(car);
      car.fixed = fixed;
      if (car.along < a0 - VIEW_PAD || car.along > a1 + VIEW_PAD) car.dead = true;
    }
  }

  let alive = 0;
  for (let i = 0; i < existing.length; i++) {
    if (!existing[i].dead) alive++;
  }

  const want = Math.ceil((a1 - a0 + VIEW_PAD * 2) / spacing);
  if (alive >= want || cars.length >= MAX_CARS) return;

  const phase =
    hash01((alongX ? 0x20000 : 0x10000) + road * 17 + lane) * spacing;
  for (
    let along = a0 - VIEW_PAD + phase;
    along <= a1 + VIEW_PAD && alive < want && cars.length < MAX_CARS;
    along += spacing
  ) {
    if (spawnBlocked(alongX, along)) continue;
    let near = false;
    for (let i = 0; i < existing.length; i++) {
      const car = existing[i];
      if (!car.dead && Math.abs(car.along - along) < spacing * 0.55) {
        near = true;
        break;
      }
    }
    if (near) continue;
    cars.push(spawnCar(alongX, road, lane, along, nextSeed++));
    alive++;
  }
}

function compactCars() {
  let w = 0;
  for (let i = 0; i < cars.length; i++) {
    if (!cars[i].dead) cars[w++] = cars[i];
  }
  cars.length = w;
}

/** Cruise-proportional ease so speed hits ~0 as remaining distance hits 0. */
function easeToStop(target, dist, cruise) {
  if (dist <= 0) return 0;
  const brakeDist = cruise * BRAKE_TIME;
  if (dist >= brakeDist) return target;
  return Math.min(target, cruise * (dist / brakeDist));
}

function updateCars(dt, timeSec) {
  /** @type {Map<string, Car[]>} */
  const groups = new Map();
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const key = `${car.alongX ? 1 : 0}:${car.road}:${car.lane}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(car);
  }

  for (const list of groups.values()) {
    const dir = LANES[list[0].lane].dir;
    list.sort((a, b) => (a.along - b.along) * dir);

    for (let i = 0; i < list.length; i++) {
      const car = list[i];
      const spec = LANES[car.lane];
      let target = spec.speed;
      /** @type {number | null} */
      let holdAt = null;

      const cross = nextCrossing(car);
      if (cross) {
        const distToStop = (cross.stop - car.along) * dir;
        const inBox = onCrossingPavement(
          car.alongX,
          car.along,
          cross.ave,
          cross.street
        );
        const mayEnter = axisMayEnter(timeSec, cross.ave, cross.street, car.alongX);

        if (!mayEnter) {
          if (inBox || distToStop < 0) {
            // Past the stop line (or in the box) on a phase change — finish clearing.
            target = spec.speed;
          } else {
            target = easeToStop(target, distToStop, spec.speed);
            holdAt = cross.stop;
          }
        }
      }

      if (i + 1 < list.length) {
        const lead = list[i + 1];
        const gap = (lead.along - car.along) * dir;
        const followDist = Math.max(0, gap - MIN_GAP);
        target = Math.min(
          target,
          easeToStop(target, followDist, spec.speed)
        );
        const followHold = lead.along - dir * MIN_GAP;
        if (holdAt == null || (followHold - holdAt) * dir < 0) {
          holdAt = followHold;
        }
      }

      car.speed = target;
      car.along += car.speed * dir * dt;

      // Clamp forward progress only — never yank backward (that reads as a teleport).
      if (holdAt != null && (car.along - holdAt) * dir > 0) {
        car.along = holdAt;
        car.speed = 0;
      }
    }
  }
}

function paintCars(data, count, maxCount, x0, z0, x1, z1, pushBox) {
  for (let i = 0; i < cars.length && count < maxCount; i++) {
    const car = cars[i];
    const x = car.alongX ? car.along : car.fixed;
    const z = car.alongX ? car.fixed : car.along;
    if (x < x0 - 2 || x > x1 + 2 || z < z0 - 2 || z > z1 + 2) continue;
    count = pushCar(
      data,
      count,
      maxCount,
      x,
      z,
      car.alongX,
      LANES[car.lane].dir,
      carColor(car.seed),
      pushBox
    );
  }
  return count;
}

/**
 * Simulate traffic with red/green lights at every avenue×street crossing.
 * Only one axis (avenues or streets) may enter an intersection at a time.
 * @returns {number} updated instance count
 */
export function paintFleet(timeSec, data, count, maxCount, x0, z0, x1, z1, pushBox) {
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const spacing = span > 100 ? SPACING_FAR : SPACING_NEAR;

  let dt = 0;
  if (lastTimeSec >= 0) dt = Math.min(MAX_DT, Math.max(0, timeSec - lastTimeSec));
  lastTimeSec = timeSec;

  const ave0 = Math.max(0, Math.floor((x0 - ROAD_W) / STRIDE_X));
  const ave1 = Math.min(BLOCKS_X, Math.floor(x1 / STRIDE_X) + 1);
  for (let i = ave0; i <= ave1; i++) {
    const roadLeft = avenueX(i);
    if (roadLeft + ROAD_W < x0 || roadLeft > x1) continue;
    for (let L = 0; L < LANES.length; L++) {
      ensureLaneCars(false, i, L, z0, z1, spacing);
    }
  }

  const s0 = Math.max(0, Math.floor((z0 - ROAD_H) / STRIDE_Y));
  const s1 = Math.min(BLOCKS_Y, Math.floor(z1 / STRIDE_Y) + 1);
  for (let s = s0; s <= s1; s++) {
    const i = BLOCKS_Y - s;
    const roadBottom = streetY(i);
    if (roadBottom + ROAD_H < z0 || roadBottom > z1) continue;
    for (let L = 0; L < LANES.length; L++) {
      ensureLaneCars(true, i, L, x0, x1, spacing);
    }
  }

  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (car.alongX) {
      if (car.fixed < z0 - VIEW_PAD || car.fixed > z1 + VIEW_PAD) car.dead = true;
    } else if (car.fixed < x0 - VIEW_PAD || car.fixed > x1 + VIEW_PAD) {
      car.dead = true;
    }
  }
  compactCars();

  if (dt > 0) updateCars(dt, timeSec);

  count = paintIntersectionLights(data, count, maxCount, timeSec, x0, z0, x1, z1, pushBox);
  return paintCars(data, count, maxCount, x0, z0, x1, z1, pushBox);
}
