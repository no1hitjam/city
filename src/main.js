import { VoxelRenderer } from "./renderer.js";
import {
  BLOCKS_X,
  BLOCKS_Y,
  ROAD_W,
  ROAD_H,
  STRIDE_X,
  STRIDE_Y,
  mapSize,
  blockOrigin,
  buildingsForBlock,
  sidewalkVoxel,
  isStreetlampAt,
  roadAt,
  roadLabel,
} from "./city.js";
import { MAT_ROOF, MAT_SKYSCRAPER, MAT_STREETLAMP } from "./materials.js";
import {
  TileLightmap,
  LAMP_RADIUS,
  LIGHT_TEX_SCALE,
  HEIGHT_FALLOFF,
} from "./lighting.js";
import { paintFleet, stampCarLights, stampSignalLights } from "./vehicles.js";

const ROAD_COLOR = [0x0c / 255, 0x0e / 255, 0x14 / 255];
const LAMP_POLE_COLOR = [0x2a / 255, 0x2c / 255, 0x32 / 255];
const LAMP_HOUSING_COLOR = [0x14 / 255, 0x14 / 255, 0x18 / 255];
const MIN_ZOOM = 8;
const MAX_ZOOM = 80;
const FLOATS_PER = 10;
const LAMP_GRID = 16;
const LAMP_POLE_H = 3.4;

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

function pushBox(data, count, ox, oy, oz, sx, sy, sz, color, emissive = 0) {
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
  return count + 1;
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
      if (isStreetlampAt(x, z)) lightmap.stampLamp(x + 0.5, z + 0.5);
    }
  }
  for (let x = startX; x < lx1; x += LAMP_GRID) {
    for (let z = lz0; z < lz1; z++) {
      if (z % LAMP_GRID === 0) continue;
      if (isStreetlampAt(x, z)) lightmap.stampLamp(x + 0.5, z + 0.5);
    }
  }

  stampCarLights(lightmap);
  stampSignalLights(lightmap, timeSec);

  lightmap.toTextureBytes();
  renderer.uploadLightmap(lightmap, LIGHT_TEX_SCALE, HEIGHT_FALLOFF);
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
    ROAD_COLOR
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
        vox.color
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
  renderer.draw();
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
