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
  roadAt,
  roadLabel,
} from "./city.js";
import { MAT_SKYSCRAPER } from "./materials.js";

const ROAD_COLOR = [0x18 / 255, 0x22 / 255, 0x1a / 255];
const MIN_ZOOM = 8;
const MAX_ZOOM = 80;
const FLOATS_PER = 9;

const canvas = document.querySelector("#view");
const infoValue = document.querySelector("#info-value");
const renderer = new VoxelRenderer(canvas);

const map = mapSize();
let camX = map.cols * 0.5;
let camZ = map.rows * 0.5;
let zoom = 28;
let hoverLabel = "";
let drag = null;

const instanceScratch = new Float32Array(256 * 1024 * FLOATS_PER);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pushBox(data, count, ox, oy, oz, sx, sy, sz, color) {
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
  return count + 1;
}

function paintVoxels() {
  const radius = renderer.viewRadius();
  const x0 = Math.max(0, Math.floor(camX - radius));
  const z0 = Math.max(0, Math.floor(camZ - radius));
  const x1 = Math.min(map.cols, Math.ceil(camX + radius));
  const z1 = Math.min(map.rows, Math.ceil(camZ + radius));
  const data = instanceScratch;
  const maxCount = Math.floor(data.length / FLOATS_PER);
  let count = 0;

  const groundSize = radius * 2.5;
  count = pushBox(
    data,
    count,
    camX,
    -0.5,
    camZ,
    groundSize,
    1,
    groundSize,
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
          const shade = 0.82 + 0.18 * ((layer * 17 + b.w) % 5) / 4;
          count = pushBox(
            data,
            count,
            ox,
            layer + 0.5,
            oz,
            b.w,
            1,
            b.d,
            [
              MAT_SKYSCRAPER.color[0] * shade,
              MAT_SKYSCRAPER.color[1] * shade,
              MAT_SKYSCRAPER.color[2] * shade,
            ]
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
    }
  }

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
  // Screen +x goes along camera right; screen +y goes along camera up-on-ground.
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
  render();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY > 0 ? 1.08 : 1 / 1.08;
  zoom *= factor;
  render();
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
    render();
  }
  updateHover(event.clientX, event.clientY);
});

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("pointerleave", () => {
  if (!drag) setInfo("");
});

window.addEventListener("resize", render);
render();
