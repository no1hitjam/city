export class SymbolGrid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this.clear();
  }

  clear(code = 32) {
    this.cells.fill(code);
  }

  put(x, y, ch) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      return;
    }
    const code = typeof ch === "number" ? ch : ch.charCodeAt(0);
    this.cells[y * this.cols + x] = code & 255;
  }

  write(x, y, text) {
    for (let i = 0; i < text.length; i++) {
      this.put(x + i, y, text.charCodeAt(i));
    }
  }
}
