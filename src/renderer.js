import { MATERIALS } from "./materials.js";

const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;
const CELL_SIZE = 14;

const BG = [0x0c / 255, 0x12 / 255, 0x0e / 255];
const FG = [0xc6 / 255, 0xf6 / 255, 0xa8 / 255];

const CUSTOM_CHARS = new Set(
  MATERIALS.filter((mat) => mat.fill).map((mat) => mat.char)
);

function materialColorLines() {
  return MATERIALS.filter((mat) => mat.color)
    .map(
      (mat) =>
        `  if (code == ${mat.char.charCodeAt(0)}u) fg = vec3(${mat.color.join(", ")});`
    )
    .join("\n");
}

const VERT_SRC = `#version 300 es
out vec2 vUv;
void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  vUv = vec2(x, y) * 0.5 + 0.5;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uChars;
uniform sampler2D uAtlas;
uniform vec2 uGridSize;
uniform vec3 uFg;
uniform vec3 uBg;

in vec2 vUv;
out vec4 oColor;

const vec2 ATLAS_GRID = vec2(16.0, 8.0);

void main() {
  vec2 gridUv = vec2(vUv.x, 1.0 - vUv.y) * uGridSize;
  ivec2 cell = ivec2(floor(gridUv));
  vec2 local = fract(gridUv);

  uint code = texelFetch(uChars, cell, 0).r;
  ivec2 atlasSize = textureSize(uAtlas, 0);
  vec2 cellPx = vec2(atlasSize) / ATLAS_GRID;
  vec2 glyph = vec2(float(code % 16u), float(code / 16u));
  vec2 atlasPx = glyph * cellPx + local * cellPx;
  vec2 atlasUv = vec2(
    atlasPx.x / float(atlasSize.x),
    1.0 - atlasPx.y / float(atlasSize.y)
  );

  float coverage = texture(uAtlas, atlasUv).a;
  vec3 fg = uFg;
${materialColorLines()}
  oColor = vec4(mix(uBg, fg, coverage), 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function link(gl, vert, frag) {
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function fitFont(ctx, cellSize) {
  const family = 'Consolas, "Courier New", monospace';
  let size = cellSize;
  while (size > 4) {
    ctx.font = `${size}px ${family}`;
    const metrics = ctx.measureText("M");
    const width = metrics.width;
    const height =
      (metrics.actualBoundingBoxAscent || size * 0.8) +
      (metrics.actualBoundingBoxDescent || size * 0.2);
    if (width <= cellSize - 1 && height <= cellSize - 1) {
      return size;
    }
    size--;
  }
  ctx.font = `4px ${family}`;
  return 4;
}

export class AsciiRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    this.gl = gl;
    this.cellSize = 0;
    this.viewW = 1;
    this.viewH = 1;
    this.originX = 0;
    this.originY = 0;
    this.gridCols = 0;
    this.gridRows = 0;
    this.gridSize = [1, 1];
    this.charW = 0;
    this.charH = 0;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = link(gl, vert, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    this.locChars = gl.getUniformLocation(this.program, "uChars");
    this.locAtlas = gl.getUniformLocation(this.program, "uAtlas");
    this.locGrid = gl.getUniformLocation(this.program, "uGridSize");
    this.locFg = gl.getUniformLocation(this.program, "uFg");
    this.locBg = gl.getUniformLocation(this.program, "uBg");

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.atlasTex = gl.createTexture();
    this.charTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.charTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      1,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      new Uint8Array([32])
    );
    this.setNearest(this.charTex);

    gl.useProgram(this.program);
    gl.uniform1i(this.locAtlas, 0);
    gl.uniform1i(this.locChars, 1);
    gl.uniform3fv(this.locFg, FG);
    gl.uniform3fv(this.locBg, BG);
  }

  setNearest(texture) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  rebuildAtlas() {
    const gl = this.gl;
    const cellSize = this.cellSize;
    const atlas = document.createElement("canvas");
    atlas.width = ATLAS_COLS * cellSize;
    atlas.height = ATLAS_ROWS * cellSize;
    const ctx = atlas.getContext("2d");
    ctx.clearRect(0, 0, atlas.width, atlas.height);
    fitFont(ctx, cellSize);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    for (let code = 33; code < 127; code++) {
      const ch = String.fromCharCode(code);
      if (CUSTOM_CHARS.has(ch)) continue;
      const col = code % ATLAS_COLS;
      const row = Math.floor(code / ATLAS_COLS);
      const metrics = ctx.measureText(ch);
      const glyphW = metrics.width;
      const ascent = metrics.actualBoundingBoxAscent || 0;
      const descent = metrics.actualBoundingBoxDescent || 0;
      const x = col * cellSize + (cellSize - glyphW) / 2;
      const y = row * cellSize + (cellSize + ascent - descent) / 2;
      ctx.fillText(ch, x, y);
    }

    const customGlyphs = MATERIALS.filter((mat) => mat.fill === "block").map(
      (mat) => [mat.char, (x, y) => ctx.fillRect(x, y, cellSize, cellSize)]
    );
    for (const [ch, draw] of customGlyphs) {
      const code = ch.charCodeAt(0);
      const col = code % ATLAS_COLS;
      const row = Math.floor(code / ATLAS_COLS);
      draw(col * cellSize, row * cellSize);
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    this.setNearest(this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const bufW = Math.max(1, Math.floor(cssW * dpr));
    const bufH = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.canvas.width = bufW;
      this.canvas.height = bufH;
    }

    const cellSize = Math.max(1, Math.round(CELL_SIZE * dpr));
    const cols = Math.max(1, Math.floor(bufW / cellSize));
    const rows = Math.max(1, Math.floor(bufH / cellSize));
    this.viewW = cols * cellSize;
    this.viewH = rows * cellSize;
    this.originX = Math.floor((bufW - this.viewW) / 2);
    this.originY = Math.floor((bufH - this.viewH) / 2);
    this.gridCols = cols;
    this.gridRows = rows;
    this.dpr = dpr;

    if (cellSize !== this.cellSize) {
      this.cellSize = cellSize;
      this.rebuildAtlas();
    }

    return { cols, rows };
  }

  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const scaleX = this.canvas.width / Math.max(1, rect.width);
    const scaleY = this.canvas.height / Math.max(1, rect.height);
    const bufX = cssX * scaleX;
    const bufY = cssY * scaleY;
    const localX = bufX - this.originX;
    const localY = bufY - this.originY;
    if (
      localX < 0 ||
      localY < 0 ||
      localX >= this.viewW ||
      localY >= this.viewH ||
      this.cellSize <= 0
    ) {
      return null;
    }
    const col = Math.floor(localX / this.cellSize);
    const row = Math.floor(localY / this.cellSize);
    if (col < 0 || row < 0 || col >= this.gridCols || row >= this.gridRows) {
      return null;
    }
    return { col, row };
  }

  upload(grid) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.charTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      grid.cols,
      grid.rows,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      grid.cells
    );
    this.setNearest(this.charTex);
    this.charW = grid.cols;
    this.charH = grid.rows;
    this.gridSize[0] = grid.cols;
    this.gridSize[1] = grid.rows;
  }

  draw() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniform2f(this.locGrid, this.gridSize[0], this.gridSize[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.charTex);

    gl.viewport(this.originX, this.originY, this.viewW, this.viewH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
