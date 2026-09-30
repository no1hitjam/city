const BG = [0x0c / 255, 0x12 / 255, 0x0e / 255];

const VERT_SRC = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aOffset;
layout(location = 3) in vec3 aScale;
layout(location = 4) in vec3 aColor;
layout(location = 5) in float aEmissive;
layout(location = 6) in float aGloss;
layout(location = 7) in float aShape;

uniform mat4 uVP;
uniform vec3 uLightDir;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vAlbedo;
out float vShade;
out float vEmissive;
out float vGloss;

// aShape: 0 box, 1/+X 2/-X 3/+Z 4/-Z wedge (low toward nose).
void main() {
  vec3 pos = aPos;
  vec3 nrm = aNormal;
  if (aShape > 0.5) {
    float along = pos.x;
    vec3 slopeN = vec3(0.78, 1.0, 0.0);
    if (aShape > 1.5 && aShape < 2.5) {
      along = -pos.x;
      slopeN = vec3(-0.78, 1.0, 0.0);
    } else if (aShape > 2.5 && aShape < 3.5) {
      along = pos.z;
      slopeN = vec3(0.0, 1.0, 0.78);
    } else if (aShape > 3.5) {
      along = -pos.z;
      slopeN = vec3(0.0, 1.0, -0.78);
    }
    // Full height at tail, ~28% at nose; bottom stays planted.
    float hFactor = mix(1.0, 0.28, along + 0.5);
    pos.y = (aPos.y + 0.5) * hFactor - 0.5;
    if (aNormal.y > 0.5) nrm = normalize(slopeN);
  }
  vec3 world = pos * aScale + aOffset;
  gl_Position = uVP * vec4(world, 1.0);
  nrm = normalize(nrm);
  float ndl = max(dot(nrm, normalize(uLightDir)), 0.0);
  vWorld = world;
  vNormal = nrm;
  vAlbedo = aColor;
  vShade = 0.4 + 0.6 * ndl;
  vEmissive = aEmissive;
  vGloss = aGloss;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uLightmap;
uniform vec2 uLightOrigin;
uniform vec2 uLightSize;
uniform float uLightScale;
uniform float uHeightFalloff;
uniform float uLightHeight;
uniform float uMirrorStrength;
uniform vec3 uCameraPos;
uniform float uWetSpecular;

in vec3 vWorld;
in vec3 vNormal;
in vec3 vAlbedo;
in float vShade;
in float vEmissive;
in float vGloss;
out vec4 oColor;

vec3 fetchTile(ivec2 tile) {
  ivec2 origin = ivec2(uLightOrigin);
  ivec2 size = ivec2(uLightSize);
  ivec2 cell = clamp(tile - origin, ivec2(0), size - ivec2(1));
  return texelFetch(uLightmap, cell, 0).rgb * uLightScale;
}

float heightAtten(float y) {
  float layer = floor(max(y, 0.0));
  return 1.0 / (1.0 + layer * uHeightFalloff);
}

// Distance falloff from a virtual point light at lightY (same XZ as the tile).
float attenFromHeight(float fragY, float lightY) {
  float layer = abs(fragY - lightY);
  return 1.0 / (1.0 + layer * uHeightFalloff);
}

vec3 sampleTileLight(vec3 world) {
  return fetchTile(ivec2(floor(world.xz))) * heightAtten(world.y);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Wet sheen: real tile light + mirrored twin at -uLightHeight (no extra stamp).
vec3 wetReflection(vec3 world, vec3 N, vec3 V, float wet) {
  ivec2 tile = ivec2(floor(world.xz));
  vec3 Lc = fetchTile(tile);
  // Neighbor taps only estimate light direction, not color.
  float gx = luma(fetchTile(tile + ivec2(1, 0))) - luma(fetchTile(tile - ivec2(1, 0)));
  float gz = luma(fetchTile(tile + ivec2(0, 1))) - luma(fetchTile(tile - ivec2(0, 1)));

  // Real lamp above + virtual image below the ground plane.
  float realW = attenFromHeight(world.y, uLightHeight);
  float mirrorW = attenFromHeight(world.y, -uLightHeight) * uMirrorStrength;
  vec3 glow = max(Lc * (realW + mirrorW) - vec3(0.09), vec3(0.0));

  // Specular from the mirrored light (pulls highlight toward the reflection).
  vec3 Ldir = normalize(vec3(-gx, -0.65, -gz) * mirrorW + vec3(-gx, 0.55, -gz) * realW + vec3(1e-4));

  float ndv = max(dot(N, V), 0.0);
  float fresnel = mix(0.18, 0.8, pow(1.0 - ndv, 2.6));

  vec3 H = normalize(Ldir + V);
  float spec = pow(max(dot(N, H), 0.0), 56.0);
  float softSpec = pow(max(dot(N, H), 0.0), 14.0);

  return wet * uWetSpecular * fresnel * (
    glow * (spec * 0.75 + softSpec * 0.15) +
    pow(glow, vec3(2.4)) * 0.12
  );
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorld);
  float topFace = step(0.55, N.y);
  float sideFace = 1.0 - step(0.55, abs(N.y));
  float wet = vGloss * topFace;
  float glass = vGloss * sideFace;

  vec3 tileLight = sampleTileLight(vWorld);
  vec3 albedo = mix(vAlbedo, vAlbedo * 0.62, wet * 0.6);
  float shade = mix(vShade, mix(vShade, 1.0, 0.08), wet);
  vec3 lit = albedo * tileLight * mix(1.0, 0.88, wet) * shade;
  lit += wetReflection(vWorld, N, V, wet);

  // Black glass on facades: dark base + view-dependent fresnel sheen.
  float ndv = max(dot(N, V), 0.0);
  float glassFresnel = mix(0.06, 0.72, pow(1.0 - ndv, 2.8));
  vec3 glassLit = vAlbedo * tileLight * shade * 0.45 + tileLight * glassFresnel * 0.85;
  lit = mix(lit, glassLit, glass);

  oColor = vec4(mix(lit, vAlbedo * 1.35, vEmissive), 1.0);
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

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

function mat4Ortho(out, left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * bt;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 2 * nf;
  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = (far + near) * nf;
  out[15] = 1;
  return out;
}

function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function mat4Invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Unit cube centered at origin, size 1, with face normals. */
function buildCubeMesh() {
  const faces = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
    { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(face.v[i][0], face.v[i][1], face.v[i][2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

const FLOATS_PER_INSTANCE = 12;

export class VoxelRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    this.gl = gl;
    this.camX = 0;
    this.camZ = 0;
    this.zoom = 18;
    this.yaw = Math.PI / 4;
    this.pitch = Math.atan(0.55);
    this.instanceCount = 0;
    this.vp = mat4Identity();
    this.invVp = mat4Identity();
    this.tmpProj = mat4Identity();
    this.tmpView = mat4Identity();
    this.lightDir = new Float32Array([-0.35, 0.9, -0.25]);
    this.lightOrigin = new Float32Array([0, 0]);
    this.lightSize = new Float32Array([1, 1]);
    this.lightScale = 2.5;
    this.heightFalloff = 0.11;
    this.lightHeight = 3.6;
    this.mirrorStrength = 0.55;
    this.cameraPos = new Float32Array([0, 20, 0]);
    this.wetSpecular = 0.35;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = link(gl, vert, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    this.locVp = gl.getUniformLocation(this.program, "uVP");
    this.locLight = gl.getUniformLocation(this.program, "uLightDir");
    this.locLightmap = gl.getUniformLocation(this.program, "uLightmap");
    this.locLightOrigin = gl.getUniformLocation(this.program, "uLightOrigin");
    this.locLightSize = gl.getUniformLocation(this.program, "uLightSize");
    this.locLightScale = gl.getUniformLocation(this.program, "uLightScale");
    this.locHeightFalloff = gl.getUniformLocation(this.program, "uHeightFalloff");
    this.locLightHeight = gl.getUniformLocation(this.program, "uLightHeight");
    this.locMirrorStrength = gl.getUniformLocation(this.program, "uMirrorStrength");
    this.locCameraPos = gl.getUniformLocation(this.program, "uCameraPos");
    this.locWetSpecular = gl.getUniformLocation(this.program, "uWetSpecular");

    const mesh = buildCubeMesh();
    this.indexCount = mesh.indices.length;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.nrmBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    this.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    this.instanceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, FLOATS_PER_INSTANCE * 4, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_INSTANCE * 4;
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 40);
    gl.vertexAttribDivisor(6, 1);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, 44);
    gl.vertexAttribDivisor(7, 1);

    this.lightTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([20, 25, 22, 255])
    );

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.useProgram(this.program);
    gl.uniform1i(this.locLightmap, 0);
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
    this.dpr = dpr;
    this.aspect = bufW / Math.max(1, bufH);
    return { width: bufW, height: bufH, aspect: this.aspect };
  }

  setCamera(camX, camZ, zoom) {
    this.camX = camX;
    this.camZ = camZ;
    if (zoom != null) this.zoom = zoom;
  }

  /** Half-extent of the ground plane visible at current zoom (map cells). */
  viewRadius() {
    const halfH = this.zoom;
    const halfW = this.zoom * this.aspect;
    return Math.ceil(Math.hypot(halfW, halfH) * 1.4);
  }

  /**
   * World-space tile bounds to mesh, padded more toward the camera
   * (screen-bottom) so buildings don't pop in while panning down.
   */
  viewBounds(camX, camZ) {
    const radius = this.viewRadius();
    const downExtra = Math.ceil(radius * 0.95);
    const dx = Math.sin(this.yaw);
    const dz = Math.cos(this.yaw);
    return {
      x0: Math.floor(camX - radius + Math.min(0, dx) * downExtra),
      z0: Math.floor(camZ - radius + Math.min(0, dz) * downExtra),
      x1: Math.ceil(camX + radius + Math.max(0, dx) * downExtra),
      z1: Math.ceil(camZ + radius + Math.max(0, dz) * downExtra),
    };
  }

  uploadInstances(data) {
    const gl = this.gl;
    const count = Math.floor(data.length / FLOATS_PER_INSTANCE);
    this.instanceCount = count;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  /**
   * Upload a tile lightmap. bytes is RGBA8 packed (see lighting.js).
   * @param {{ originX: number, originZ: number, w: number, h: number, rgba: Uint8Array }} map
   * @param {number} decodeScale
   * @param {number} heightFalloff
   * @param {number} [wetSpecular]
   * @param {number} [lightHeight]
   * @param {number} [mirrorStrength]
   */
  uploadLightmap(map, decodeScale, heightFalloff, wetSpecular, lightHeight, mirrorStrength) {
    const gl = this.gl;
    this.lightOrigin[0] = map.originX;
    this.lightOrigin[1] = map.originZ;
    this.lightSize[0] = map.w;
    this.lightSize[1] = map.h;
    this.lightScale = decodeScale;
    this.heightFalloff = heightFalloff;
    if (wetSpecular != null) this.wetSpecular = wetSpecular;
    if (lightHeight != null) this.lightHeight = lightHeight;
    if (mirrorStrength != null) this.mirrorStrength = mirrorStrength;
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      map.w,
      map.h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      map.rgba.subarray(0, map.w * map.h * 4)
    );
  }

  updateMatrices() {
    const eyeDist = this.zoom * 2.4;
    const cy = Math.sin(this.pitch) * eyeDist;
    const ch = Math.cos(this.pitch) * eyeDist;
    const eyeX = this.camX + Math.sin(this.yaw) * ch;
    const eyeZ = this.camZ + Math.cos(this.yaw) * ch;
    const eye = [eyeX, cy, eyeZ];
    this.cameraPos[0] = eyeX;
    this.cameraPos[1] = cy;
    this.cameraPos[2] = eyeZ;
    const center = [this.camX, 0, this.camZ];
    const up = [0, 1, 0];

    mat4LookAt(this.tmpView, eye, center, up);
    const halfH = this.zoom;
    const halfW = this.zoom * this.aspect;
    mat4Ortho(this.tmpProj, -halfW, halfW, -halfH, halfH, -eyeDist * 4, eyeDist * 8);
    mat4Multiply(this.vp, this.tmpProj, this.tmpView);
    mat4Invert(this.invVp, this.vp);
  }

  draw() {
    const gl = this.gl;
    this.updateMatrices();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.instanceCount <= 0) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locVp, false, this.vp);
    gl.uniform3fv(this.locLight, this.lightDir);
    gl.uniform2fv(this.locLightOrigin, this.lightOrigin);
    gl.uniform2fv(this.locLightSize, this.lightSize);
    gl.uniform1f(this.locLightScale, this.lightScale);
    gl.uniform1f(this.locHeightFalloff, this.heightFalloff);
    gl.uniform1f(this.locLightHeight, this.lightHeight);
    gl.uniform1f(this.locMirrorStrength, this.mirrorStrength);
    gl.uniform3fv(this.locCameraPos, this.cameraPos);
    gl.uniform1f(this.locWetSpecular, this.wetSpecular);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(
      gl.TRIANGLES,
      this.indexCount,
      gl.UNSIGNED_SHORT,
      0,
      this.instanceCount
    );
  }

  /**
   * Map a screen point to ground-plane (y=0) map coordinates.
   * @returns {{ x: number, z: number } | null}
   */
  pickGround(clientX, clientY) {
    this.updateMatrices();
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
    const inv = this.invVp;
    if (!inv) return null;

    function unproject(nx, ny, nz) {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
      const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
      const iw = w !== 0 ? 1 / w : 1;
      return [x * iw, y * iw, z * iw];
    }

    const near = unproject(ndcX, ndcY, -1);
    const far = unproject(ndcX, ndcY, 1);
    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];
    if (Math.abs(dy) < 1e-8) return null;
    const t = -near[1] / dy;
    if (t < 0) return null;
    return { x: near[0] + dx * t, z: near[2] + dz * t };
  }
}
