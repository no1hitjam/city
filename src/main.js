import { SymbolGrid } from "./grid.js";
import { AsciiRenderer } from "./renderer.js";
import {
  STRIDE_X,
  STRIDE_Y,
  mapSize,
  cellChar,
  roadAt,
  roadLabel,
} from "./city.js";

const canvas = document.querySelector("#view");
const infoValue = document.querySelector("#info-value");
const renderer = new AsciiRenderer(canvas);

let camX = 0;
let camY = 1e9;
let hoverLabel = "";
let drag = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function viewOrigin() {
  return {
    x: Math.floor(camX),
    y: Math.floor(camY),
  };
}

function paintCity(grid) {
  grid.clear();
  const map = mapSize();
  camX = clamp(camX, 0, Math.max(0, map.cols - grid.cols));
  camY = clamp(camY, 0, Math.max(0, map.rows - grid.rows));
  const origin = viewOrigin();

  for (let row = 0; row < grid.rows; row++) {
    const mapY = origin.y + row;
    if (mapY >= map.rows) continue;
    for (let col = 0; col < grid.cols; col++) {
      const mapX = origin.x + col;
      if (mapX >= map.cols) continue;
      const ch = cellChar(mapX, mapY);
      if (ch !== " ") grid.put(col, row, ch);
    }
  }
}

function setInfo(text) {
  if (text === hoverLabel) return;
  hoverLabel = text;
  infoValue.textContent = text;
}

function updateHover(clientX, clientY) {
  const cell = renderer.cellAt(clientX, clientY);
  if (!cell) {
    setInfo("");
    return;
  }
  const map = mapSize();
  const origin = viewOrigin();
  const mapX = origin.x + cell.col;
  const mapY = origin.y + cell.row;
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

function render() {
  const { cols, rows } = renderer.resize();
  const grid = new SymbolGrid(cols, rows);
  paintCity(grid);
  renderer.upload(grid);
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

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const stepX = event.shiftKey ? STRIDE_X : 1;
  const stepY = event.shiftKey ? STRIDE_Y : 1;
  if (event.key === "ArrowLeft") camX -= stepX;
  else if (event.key === "ArrowRight") camX += stepX;
  else if (event.key === "ArrowUp") camY -= stepY;
  else if (event.key === "ArrowDown") camY += stepY;
  else return;
  event.preventDefault();
  render();
});

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
    const cellW = Math.max(1, renderer.cellW);
    const cellH = Math.max(1, renderer.cellH);
    camX -= (point.x - drag.x) / cellW;
    camY -= (point.y - drag.y) / cellH;
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
