/** How many streak instances to keep in flight. */
const DROP_COUNT = 3200;
/** World Y where drops spawn. */
const RAIN_TOP = 34;
/** World Y where drops despawn (just below ground). */
const RAIN_BOTTOM = -0.5;
/** Base fall speed (map cells / sec). */
const FALL_SPEED = 22;
/** Streak length range (map cells). */
const STREAK_MIN = 0.55;
const STREAK_MAX = 1.35;
/** Streak half-width (map cells). */
const STREAK_HALF_W = 0.055;
/** Horizontal coverage as a multiple of view zoom. */
const SPAN_ZOOM = 2.6;
/** Slight wind lean. */
const WIND_X = 0.12;
const WIND_Z = -0.04;

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aId;

uniform mat4 uVP;
uniform float uTime;
uniform vec2 uCamXZ;
uniform float uSpan;
uniform vec3 uCamRight;

out vec3 vWorld;
out float vFade;

vec3 hash31(float n) {
  vec3 p = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xxy + p.yzz) * p.zyx);
}

void main() {
  vec3 h = hash31(aId + 1.7);
  vec3 h2 = hash31(aId + 91.3);
  float speed = ${FALL_SPEED.toFixed(1)} * mix(0.75, 1.35, h.x);
  float life = fract(
    uTime * (speed / (${RAIN_TOP.toFixed(1)} - (${RAIN_BOTTOM.toFixed(1)}))) + h.y
  );
  float yHead = mix(${RAIN_TOP.toFixed(1)}, ${RAIN_BOTTOM.toFixed(1)}, life);
  float streak = mix(${STREAK_MIN.toFixed(2)}, ${STREAK_MAX.toFixed(2)}, h.z);
  float yMid = yHead + streak * 0.5;
  float windT = (${RAIN_TOP.toFixed(1)} - yMid) * 0.5;
  vec2 xz = uCamXZ + (h2.xy * 2.0 - 1.0) * uSpan
    + vec2(${WIND_X.toFixed(3)}, ${WIND_Z.toFixed(3)}) * windT;

  vec3 center = vec3(xz.x, yMid, xz.y);
  vec3 fallDir = normalize(vec3(${WIND_X.toFixed(3)}, -1.0, ${WIND_Z.toFixed(3)}));
  // Offset sideways in screen space so streaks stay readable at any yaw.
  vec3 side = normalize(uCamRight - fallDir * dot(uCamRight, fallDir));
  vWorld = center
    + side * (aCorner.x * ${STREAK_HALF_W.toFixed(3)} * 2.0)
    + fallDir * (aCorner.y * streak);

  // Soft tip/tail; keep the core bright.
  vFade = 1.0 - abs(aCorner.y) * 0.85;
  gl_Position = uVP * vec4(vWorld, 1.0);
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

in vec3 vWorld;
in float vFade;
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

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec3 tile = fetchTile(ivec2(floor(vWorld.xz)));
  // Rain catches lamp columns aloft — softer height falloff than solid voxels.
  float atten = mix(0.55, 1.0, heightAtten(vWorld.y));
  vec3 lit = tile * atten;

  // Only irradiance well above night fill lights a streak.
  vec3 excess = max(lit - vec3(0.16), vec3(0.0));
  float bright = luma(excess);
  float visibility = smoothstep(0.03, 0.4, bright);
  if (visibility <= 0.001) discard;

  // Color tracks lightmap directly (lamps cool, signals / windows warm).
  vec3 tint = excess * 1.8;
  float alpha = visibility * vFade * 0.45;
  oColor = vec4(tint * alpha, alpha);
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

/**
 * Camera-relative rain streaks that sample the tile lightmap for color.
 */
export class RainPass {
  constructor(gl) {
    this.gl = gl;
    this.dropCount = DROP_COUNT;
    this.camRight = new Float32Array([1, 0, 0]);

    const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = link(gl, vert, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    this.locVp = gl.getUniformLocation(this.program, "uVP");
    this.locTime = gl.getUniformLocation(this.program, "uTime");
    this.locCamXZ = gl.getUniformLocation(this.program, "uCamXZ");
    this.locSpan = gl.getUniformLocation(this.program, "uSpan");
    this.locCamRight = gl.getUniformLocation(this.program, "uCamRight");
    this.locLightmap = gl.getUniformLocation(this.program, "uLightmap");
    this.locLightOrigin = gl.getUniformLocation(this.program, "uLightOrigin");
    this.locLightSize = gl.getUniformLocation(this.program, "uLightSize");
    this.locLightScale = gl.getUniformLocation(this.program, "uLightScale");
    this.locHeightFalloff = gl.getUniformLocation(this.program, "uHeightFalloff");

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Two triangles → thin streak quad in local corner space.
    const corners = new Float32Array([
      -0.5, -0.5,
      0.5, -0.5,
      0.5, 0.5,
      -0.5, -0.5,
      0.5, 0.5,
      -0.5, 0.5,
    ]);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const ids = new Float32Array(DROP_COUNT);
    for (let i = 0; i < DROP_COUNT; i++) ids[i] = i;
    this.idBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.uniform1i(this.locLightmap, 0);
  }

  /**
   * Draw after the voxel pass. Depth-tested, no depth write, additive.
   * @param {{
   *   vp: Float32Array,
   *   view: Float32Array,
   *   timeSec: number,
   *   camX: number,
   *   camZ: number,
   *   zoom: number,
   *   aspect: number,
   *   lightTex: WebGLTexture,
   *   lightOrigin: Float32Array,
   *   lightSize: Float32Array,
   *   lightScale: number,
   *   heightFalloff: number,
   * }} opts
   */
  draw(opts) {
    const gl = this.gl;
    const span = opts.zoom * Math.max(1, opts.aspect) * SPAN_ZOOM;
    // View matrix rows 0: camera right in world space (column-major).
    const view = opts.view;
    this.camRight[0] = view[0];
    this.camRight[1] = view[4];
    this.camRight[2] = view[8];

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locVp, false, opts.vp);
    gl.uniform1f(this.locTime, opts.timeSec);
    gl.uniform2f(this.locCamXZ, opts.camX, opts.camZ);
    gl.uniform1f(this.locSpan, span);
    gl.uniform3fv(this.locCamRight, this.camRight);
    gl.uniform2fv(this.locLightOrigin, opts.lightOrigin);
    gl.uniform2fv(this.locLightSize, opts.lightSize);
    gl.uniform1f(this.locLightScale, opts.lightScale);
    gl.uniform1f(this.locHeightFalloff, opts.heightFalloff);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.lightTex);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.dropCount);

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }
}
