import { VoxelRenderer } from "./renderer.js";
import {
  BLOCKS_X,
  BLOCKS_Y,
  ROAD_W,
  ROAD_H,
  STRIDE_X,
  STRIDE_Y,
  BUILDING_MAX_H,
  mapSize,
  blockOrigin,
  buildingsForBlock,
  sidewalkVoxel,
  isStreetlampAt,
  streetlampOutward,
  roadAt,
  roadLabel,
} from "./city.js";
import {
  MAT_ROOF,
  MAT_SKYSCRAPER,
  MAT_STREETLAMP,
  MAT_WINDOW,
  MAT_WINDOW_LIT,
} from "./materials.js";
import {
  TileLightmap,
  LAMP_RADIUS,
  LAMP_COLOR,
  LIGHT_TEX_SCALE,
  HEIGHT_FALLOFF,
  LIGHT_HEIGHT,
  MIRROR_STRENGTH,
  WET_SPECULAR,
} from "./lighting.js";
import { paintFleet, stampCarLights, stampSignalLights } from "./vehicles.js";

const ROAD_COLOR = [0x08 / 255, 0x09 / 255, 0x0e / 255];
const LAMP_POLE_COLOR = [0x2a / 255, 0x2c / 255, 0x32 / 255];
const LAMP_HOUSING_COLOR = [0x14 / 255, 0x14 / 255, 0x18 / 255];
const MIN_ZOOM = 8;
const MAX_ZOOM = 80;
const FLOATS_PER = 12;
const LAMP_GRID = 16;
const LAMP_POLE_H = 3.4;
/** Window pane size along the facade / height. */
const WINDOW_SPAN = 0.52;
/** How deep the pane sits into the wall. */
const WINDOW_INSET = 0.08;
/** Center-to-center spacing along the facade. */
const WINDOW_PITCH = 1.2;
/** Keep panes clear of building corners. */
const WINDOW_MARGIN = 0.85;
/** Fraction of panes that glow (stable per world position). */
const WINDOW_LIT_CHANCE = 0.32;
/** Peak intensity for a lit-pane street reflection pool. */
const WINDOW_GLOW_INTENSITY = 0.7;
/** Peak intensity for a streetlamp reflection pool (same orthographic trick). */
const LAMP_GLOW_INTENSITY = 0.85;
/** How far a top-floor pane can project its ground reflection. */
const WINDOW_REFLECT_REACH = BUILDING_MAX_H * 2;

const canvas = document.querySelector("#view");
const infoValue = document.querySelector("#info-value");
const renderer = new VoxelRenderer(canvas);
const lightmap = new TileLightmap();

const map = mapSize();
let camX = map.cols * 0.5;
let camZ = map.rows * 0.5;
let zoom = 28;
let hoverLabel = "";
let drag = null;
let timeSec = 0;

const instanceScratch = new Float32Array(256 * 1024 * FLOATS_PER);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pushBox(data, count, ox, oy, oz, sx, sy, sz, color, emissive = 0, gloss = 0, shape = 0) {
  const i = count * FLOATS_PER;
  data[i] = ox;
  data[i + 1] = oy;
  data[i + 2] = oz;
  data[i + 3] = sx;
  data[i + 4] = sy;
  data[i + 5] = sz;
  data[i + 6] = color[0];
  data[i + 7] = color[1];
  data[i + 8] = color[2];
  data[i + 9] = emissive;
  data[i + 10] = gloss;
  data[i + 11] = shape;
  return count + 1;
}

/** Evenly spaced centers from [start, end] with preferred pitch. */
function gridCenters(start, end, pitch) {
  const span = end - start;
  if (span <= 0) return [];
  const n = Math.max(1, Math.round(span / pitch));
  const step = span / n;
  const centers = [];
  for (let i = 0; i < n; i++) centers.push(start + (i + 0.5) * step);
  return centers;
}

/** Deterministic 0..1 hash from pane world position + face id. */
function windowLitRoll(x, y, z, face) {
  let h =
    Math.imul(Math.floor(x * 8 + 0.5) + 1, 374761393) ^
    Math.imul(Math.floor(y * 8 + 0.5) + 1, 668265263) ^
    Math.imul(Math.floor(z * 8 + 0.5) + 1, 1274126177) ^
    Math.imul(face + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

function isWindowLit(ox, oy, oz, face) {
  return windowLitRoll(ox, oy, oz, face) < WINDOW_LIT_CHANCE;
}

/**
 * Cheap mirror of a lit pane: stamp the street tile at 2 * height outward
 * from the facade (inverted height mapped onto the ground plane).
 */
function stampWindowGlow(ox, oy, oz, face) {
  const dist = oy * 2;
  const nx = face === 2 ? 1 : face === 3 ? -1 : 0;
  const nz = face === 0 ? 1 : face === 1 ? -1 : 0;
  const atten = 1 / (1 + dist * HEIGHT_FALLOFF);
  lightmap.stampTile(
    ox + nx * dist,
    oz + nz * dist,
    MAT_WINDOW_LIT.color,
    WINDOW_GLOW_INTENSITY * atten
  );
}

/** Same orthographic reflection for a streetlamp bulb into the adjacent road. */
function stampStreetlampGlow(cx, cz) {
  const dir = streetlampOutward(Math.floor(cx), Math.floor(cz));
  if (!dir) return;
  const dist = LIGHT_HEIGHT * 2;
  const atten = 1 / (1 + dist * HEIGHT_FALLOFF);
  lightmap.stampTile(
    cx + dir.nx * dist,
    cz + dir.nz * dist,
    LAMP_COLOR,
    LAMP_GLOW_INTENSITY * atten
  );
}

function stampStreetlamp(x, z) {
  const cx = x + 0.5;
  const cz = z + 0.5;
  lightmap.stampLamp(cx, cz);
  stampStreetlampGlow(cx, cz);
}

function pushWindow(data, count, ox, oy, oz, sx, sy, sz, face) {
  const lit = isWindowLit(ox, oy, oz, face);
  return pushBox(
    data,
    count,
    ox,
    oy,
    oz,
    sx,
    sy,
    sz,
    lit ? MAT_WINDOW_LIT.color : MAT_WINDOW.color,
    lit ? 1 : 0,
    lit ? 0 : 1
  );
}

/**
 * Shared facade grid for paint + reflection stamps.
 * @returns {{ xs: number[], zs: number[], faceN: number, faceS: number, faceE: number, faceW: number, depth: number } | null}
 */
function buildingWindowLayout(ox, oz, b) {
  if (b.h < 2 || b.w < 3 || b.d < 3) return null;

  const halfW = b.w * 0.5;
  const halfD = b.d * 0.5;
  const x0 = ox - halfW + WINDOW_MARGIN;
  const x1 = ox + halfW - WINDOW_MARGIN;
  const z0 = oz - halfD + WINDOW_MARGIN;
  const z1 = oz + halfD - WINDOW_MARGIN;
  const xs = gridCenters(x0, x1, WINDOW_PITCH);
  const zs = gridCenters(z0, z1, WINDOW_PITCH);
  if (xs.length === 0 && zs.length === 0) return null;

  const depth = WINDOW_INSET;
  // Mostly buried in the wall; a hair of the pane sticks out so it's visible.
  return {
    xs,
    zs,
    depth,
    faceN: oz + halfD - depth * 0.5 + 0.015,
    faceS: oz - halfD + depth * 0.5 - 0.015,
    faceE: ox + halfW - depth * 0.5 + 0.015,
    faceW: ox - halfW + depth * 0.5 - 0.015,
  };
}

/** Cheap wet-ground glow: lit panes stamp the tile under them at path length 2h. */
function stampBuildingWindowGlows(ox, oz, b) {
  const layout = buildingWindowLayout(ox, oz, b);
  if (!layout) return;
  const { xs, zs, faceN, faceS, faceE, faceW } = layout;

  for (let layer = 0; layer < b.h - 1; layer++) {
    const cy = layer + 0.5;
    for (let i = 0; i < xs.length; i++) {
      if (isWindowLit(xs[i], cy, faceN, 0)) stampWindowGlow(xs[i], cy, faceN, 0);
      if (isWindowLit(xs[i], cy, faceS, 1)) stampWindowGlow(xs[i], cy, faceS, 1);
    }
    for (let i = 0; i < zs.length; i++) {
      if (isWindowLit(faceE, cy, zs[i], 2)) stampWindowGlow(faceE, cy, zs[i], 2);
      if (isWindowLit(faceW, cy, zs[i], 3)) stampWindowGlow(faceW, cy, zs[i], 3);
    }
  }
}

/**
 * Glossy black / lit window panes inset into the four vertical faces.
 * One row per occupied floor (excluding roof); columns along each facade.
 */
function paintBuildingWindows(data, count, maxCount, ox, oz, b) {
  const layout = buildingWindowLayout(ox, oz, b);
  if (!layout) return count;
  const { xs, zs, depth, faceN, faceS, faceE, faceW } = layout;

  for (let layer = 0; layer < b.h - 1 && count < maxCount; layer++) {
    const cy = layer + 0.5;
    for (let i = 0; i < xs.length && count < maxCount; i++) {
      count = pushWindow(
        data,
        count,
        xs[i],
        cy,
        faceN,
        WINDOW_SPAN,
        WINDOW_SPAN,
        depth,
        0
      );
      if (count >= maxCount) return count;
      count = pushWindow(
        data,
        count,
        xs[i],
        cy,
        faceS,
        WINDOW_SPAN,
        WINDOW_SPAN,
        depth,
        1
      );
    }
    for (let i = 0; i < zs.length && count < maxCount; i++) {
      count = pushWindow(
        data,
        count,
        faceE,
        cy,
        zs[i],
        depth,
        WINDOW_SPAN,
        WINDOW_SPAN,
        2
      );
      if (count >= maxCount) return count;
      count = pushWindow(
        data,
        count,
        faceW,
        cy,
        zs[i],
        depth,
        WINDOW_SPAN,
        WINDOW_SPAN,
        3
      );
    }
  }
  return count;
}

/** Dark pole + lantern housing with a bright emissive bulb. */
function paintStreetlamp(data, count, maxCount, x, z) {
  const cx = x + 0.5;
  const cz = z + 0.5;
  const headY = LAMP_POLE_H + 0.2;

  count = pushBox(data, count, cx, 0.12, cz, 0.38, 0.24, 0.38, LAMP_POLE_COLOR);
  if (count >= maxCount) return count;
  count = pushBox(
    data,
    count,
    cx,
    LAMP_POLE_H * 0.5,
    cz,
    0.14,
    LAMP_POLE_H,
    0.14,
    LAMP_POLE_COLOR
  );
  if (count >= maxCount) return count;
  // Dark collar under the bulb.
  count = pushBox(
    data,
    count,
    cx,
    headY - 0.2,
    cz,
    0.34,
    0.1,
    0.34,
    LAMP_HOUSING_COLOR
  );
  if (count >= maxCount) return count;
  // Glowing bulb (current streetlamp color).
  count = pushBox(
    data,
    count,
    cx,
    headY,
    cz,
    0.3,
    0.28,
    0.3,
    MAT_STREETLAMP.color,
    1
  );
  if (count >= maxCount) return count;
  // Dark cap above the bulb.
  return pushBox(
    data,
    count,
    cx,
    headY + 0.22,
    cz,
    0.36,
    0.1,
    0.36,
    LAMP_HOUSING_COLOR
  );
}

function rebuildLightmap(x0, z0, x1, z1) {
  const pad = LAMP_RADIUS + 1;
  const lx0 = Math.max(0, x0 - pad);
  const lz0 = Math.max(0, z0 - pad);
  const lx1 = Math.min(map.cols, x1 + pad);
  const lz1 = Math.min(map.rows, z1 + pad);
  lightmap.begin(lx0, lz0, lx1, lz1);

  // Lamps only occur on the world-aligned LAMP_GRID; test those candidates.
  const startX = Math.floor(lx0 / LAMP_GRID) * LAMP_GRID;
  const startZ = Math.floor(lz0 / LAMP_GRID) * LAMP_GRID;
  for (let z = startZ; z < lz1; z += LAMP_GRID) {
    for (let x = lx0; x < lx1; x++) {
      if (isStreetlampAt(x, z)) stampStreetlamp(x, z);
    }
  }
  for (let x = startX; x < lx1; x += LAMP_GRID) {
    for (let z = lz0; z < lz1; z++) {
      if (z % LAMP_GRID === 0) continue;
      if (isStreetlampAt(x, z)) stampStreetlamp(x, z);
    }
  }

  stampCarLights(lightmap);
  stampSignalLights(lightmap, timeSec);

  // Lit window reflections: each pane stamps a street tile at 2 * height out.
  // Search beyond the lightmap so offscreen facades can still light in-view street.
  const wx0 = lx0 - WINDOW_REFLECT_REACH;
  const wz0 = lz0 - WINDOW_REFLECT_REACH;
  const wx1 = lx1 + WINDOW_REFLECT_REACH;
  const wz1 = lz1 + WINDOW_REFLECT_REACH;
  const bx0 = clamp(Math.floor((wx0 - ROAD_W) / STRIDE_X), 0, BLOCKS_X - 1);
  const bx1 = clamp(Math.floor((wx1 - ROAD_W) / STRIDE_X), 0, BLOCKS_X - 1);
  const row0 = clamp(Math.floor((wz0 - ROAD_H) / STRIDE_Y), 0, BLOCKS_Y - 1);
  const row1 = clamp(Math.floor((wz1 - ROAD_H) / STRIDE_Y), 0, BLOCKS_Y - 1);
  for (let row = row0; row <= row1; row++) {
    const by = BLOCKS_Y - 1 - row;
    for (let bx = bx0; bx <= bx1; bx++) {
      const origin = blockOrigin(bx, by);
      const buildings = buildingsForBlock(bx, by);
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        const ox = origin.x + b.x + b.w * 0.5;
        const oz = origin.y + b.y + b.d * 0.5;
        if (
          ox + b.w * 0.5 < wx0 ||
          ox - b.w * 0.5 > wx1 ||
          oz + b.d * 0.5 < wz0 ||
          oz - b.d * 0.5 > wz1
        ) {
          continue;
        }
        stampBuildingWindowGlows(ox, oz, b);
      }
    }
  }

  lightmap.toTextureBytes();
  renderer.uploadLightmap(
    lightmap,
    LIGHT_TEX_SCALE,
    HEIGHT_FALLOFF,
    WET_SPECULAR,
    LIGHT_HEIGHT,
    MIRROR_STRENGTH
  );
}

function paintVoxels() {
  const bounds = renderer.viewBounds(camX, camZ);
  const x0 = Math.max(0, bounds.x0);
  const z0 = Math.max(0, bounds.z0);
  const x1 = Math.min(map.cols, bounds.x1);
  const z1 = Math.min(map.rows, bounds.z1);

  rebuildLightmap(x0, z0, x1, z1);

  const data = instanceScratch;
  const maxCount = Math.floor(data.length / FLOATS_PER);
  let count = 0;

  const groundW = Math.max(x1 - x0, 1) + 4;
  const groundD = Math.max(z1 - z0, 1) + 4;
  count = pushBox(
    data,
    count,
    (x0 + x1) * 0.5,
    -0.5,
    (z0 + z1) * 0.5,
    groundW,
    1,
    groundD,
    ROAD_COLOR,
    0,
    1
  );

  const bx0 = clamp(Math.floor((x0 - ROAD_W) / STRIDE_X), 0, BLOCKS_X - 1);
  const bx1 = clamp(Math.floor((x1 - ROAD_W) / STRIDE_X), 0, BLOCKS_X - 1);
  const row0 = clamp(Math.floor((z0 - ROAD_H) / STRIDE_Y), 0, BLOCKS_Y - 1);
  const row1 = clamp(Math.floor((z1 - ROAD_H) / STRIDE_Y), 0, BLOCKS_Y - 1);

  for (let row = row0; row <= row1 && count < maxCount; row++) {
    const by = BLOCKS_Y - 1 - row;
    for (let bx = bx0; bx <= bx1 && count < maxCount; bx++) {
      const origin = blockOrigin(bx, by);
      const buildings = buildingsForBlock(bx, by);
      for (let i = 0; i < buildings.length && count < maxCount; i++) {
        const b = buildings[i];
        const ox = origin.x + b.x + b.w * 0.5;
        const oz = origin.y + b.y + b.d * 0.5;
        if (
          ox + b.w * 0.5 < x0 ||
          ox - b.w * 0.5 > x1 ||
          oz + b.d * 0.5 < z0 ||
          oz - b.d * 0.5 > z1
        ) {
          continue;
        }
        for (let layer = 0; layer < b.h && count < maxCount; layer++) {
          const isRoof = layer === b.h - 1;
          const base = isRoof ? MAT_ROOF.color : MAT_SKYSCRAPER.color;
          const shade = isRoof
            ? 1
            : 0.82 + 0.18 * (((layer * 17 + b.w) % 5) / 4);
          count = pushBox(
            data,
            count,
            ox,
            layer + 0.5,
            oz,
            b.w,
            1,
            b.d,
            [base[0] * shade, base[1] * shade, base[2] * shade]
          );
        }
        if (count < maxCount) {
          count = paintBuildingWindows(data, count, maxCount, ox, oz, b);
        }
      }
    }
  }

  for (let z = z0; z < z1 && count < maxCount; z++) {
    for (let x = x0; x < x1 && count < maxCount; x++) {
      const vox = sidewalkVoxel(x, z);
      if (!vox) continue;
      count = pushBox(
        data,
        count,
        x + 0.5,
        vox.h * 0.5,
        z + 0.5,
        1,
        vox.h,
        1,
        vox.color,
        0,
        1
      );
      if (count >= maxCount) break;
      if (isStreetlampAt(x, z)) {
        count = paintStreetlamp(data, count, maxCount, x, z);
      }
    }
  }

  count = paintFleet(
    timeSec,
    data,
    count,
    maxCount,
    x0,
    z0,
    x1,
    z1,
    pushBox
  );

  renderer.uploadInstances(data.subarray(0, count * FLOATS_PER));
}

function setInfo(text) {
  if (text === hoverLabel) return;
  hoverLabel = text;
  infoValue.textContent = text;
}

function updateHover(clientX, clientY) {
  const hit = renderer.pickGround(clientX, clientY);
  if (!hit) {
    setInfo("");
    return;
  }
  const mapX = Math.floor(hit.x);
  const mapY = Math.floor(hit.z);
  if (mapX < 0 || mapY < 0 || mapX >= map.cols || mapY >= map.rows) {
    setInfo("");
    return;
  }
  setInfo(roadLabel(roadAt(mapX, mapY)));
}

function clientToBuffer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  };
}

function clampCamera() {
  camX = clamp(camX, 0, map.cols);
  camZ = clamp(camZ, 0, map.rows);
  zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

function render() {
  renderer.resize();
  clampCamera();
  renderer.setCamera(camX, camZ, zoom);
  paintVoxels();
  renderer.draw(timeSec);
}

function frame(nowMs) {
  timeSec = nowMs * 0.001;
  render();
  requestAnimationFrame(frame);
}

function endDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  canvas.classList.remove("dragging");
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch (_) {
    // Capture may already be released.
  }
}

function panFromScreenDelta(dxPx, dyPx) {
  const halfH = zoom;
  const halfW = zoom * renderer.aspect;
  const worldDx = (dxPx / canvas.width) * halfW * 2;
  const worldDy = (dyPx / canvas.height) * halfH * 2;
  const cos = Math.cos(renderer.yaw);
  const sin = Math.sin(renderer.yaw);
  camX -= worldDx * cos + worldDy * sin;
  camZ -= -worldDx * sin + worldDy * cos;
}

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = event.shiftKey ? STRIDE_X : 4;
  if (event.key === "ArrowLeft") camX -= step;
  else if (event.key === "ArrowRight") camX += step;
  else if (event.key === "ArrowUp") camZ -= step;
  else if (event.key === "ArrowDown") camZ += step;
  else if (event.key === "=" || event.key === "+") zoom *= 0.9;
  else if (event.key === "-" || event.key === "_") zoom *= 1.1;
  else return;
  event.preventDefault();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY > 0 ? 1.08 : 1 / 1.08;
  zoom *= factor;
}, { passive: false });

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const point = clientToBuffer(event.clientX, event.clientY);
  drag = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
  };
  canvas.classList.add("dragging");
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (_) {
    // Some environments reject capture for synthetic pointers.
  }
  event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => {
  if (drag && drag.pointerId === event.pointerId) {
    const point = clientToBuffer(event.clientX, event.clientY);
    panFromScreenDelta(point.x - drag.x, point.y - drag.y);
    drag.x = point.x;
    drag.y = point.y;
  }
  updateHover(event.clientX, event.clientY);
});

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("pointerleave", () => {
  if (!drag) setInfo("");
});

requestAnimationFrame(frame);
