import { SymbolGrid } from "./grid.js";
import { AsciiRenderer } from "./renderer.js";

const MESSAGE = [
  "CITY",
  "",
  "A grid of symbols",
  "",
  "THE QUICK BROWN FOX JUMPS OVER",
  "THE LAZY DOG",
  "",
  "0123456789  !@#$%^&*()_+-=",
  "abcdefghijklmnopqrstuvwxyz",
];

function drawBox(grid, x, y, w, h) {
  for (let col = 0; col < w; col++) {
    grid.put(x + col, y, "-");
    grid.put(x + col, y + h - 1, "-");
  }
  for (let row = 0; row < h; row++) {
    grid.put(x, y + row, "|");
    grid.put(x + w - 1, y + row, "|");
  }
  grid.put(x, y, "+");
  grid.put(x + w - 1, y, "+");
  grid.put(x, y + h - 1, "+");
  grid.put(x + w - 1, y + h - 1, "+");
}

function paintTest(grid) {
  const innerW = MESSAGE.reduce((max, line) => Math.max(max, line.length), 0);
  const innerH = MESSAGE.length;
  const boxW = innerW + 4;
  const boxH = innerH + 4;
  const x0 = Math.floor((grid.cols - boxW) / 2);
  const y0 = Math.floor((grid.rows - boxH) / 2);
  const boxed = x0 >= 0 && y0 >= 0;

  if (boxed) {
    drawBox(grid, x0, y0, boxW, boxH);
  }

  const textX = boxed ? x0 + 2 : 0;
  const textY = boxed ? y0 + 2 : Math.max(0, Math.floor((grid.rows - innerH) / 2));
  const textW = boxed ? innerW : grid.cols;

  for (let i = 0; i < MESSAGE.length; i++) {
    const line = MESSAGE[i];
    const x = textX + Math.floor((textW - line.length) / 2);
    grid.write(x, textY + i, line);
  }

  const label = `${grid.cols}x${grid.rows}`;
  const labelY = grid.rows - 1;
  if (!boxed || y0 + boxH < labelY) {
    grid.write(Math.max(0, grid.cols - label.length), labelY, label);
  }
}

const canvas = document.querySelector("#view");
const renderer = new AsciiRenderer(canvas);

function layout() {
  const { cols, rows } = renderer.resize();
  const grid = new SymbolGrid(cols, rows);
  paintTest(grid);
  renderer.upload(grid);
  renderer.draw();
}

window.addEventListener("resize", layout);
layout();
