import { MAT_STREETLAMP } from "./materials.js";

/** How many tiles a lamp reaches. */
export const LAMP_RADIUS = 14;
/** Peak brightness at the lamp tile. */
export const LAMP_INTENSITY = 0.95;
/** Soft night fill so unlit tiles stay readable. */
export const AMBIENT_LIGHT = [0.08, 0.095, 0.09];
/** Extra attenuation per voxel of height above ground. */
export const HEIGHT_FALLOFF = 0.16;
/** Nominal lamp height used for real + mirrored virtual lights. */
export const LIGHT_HEIGHT = 3.6;
/**
 * Strength of the virtual light placed at -LIGHT_HEIGHT (wet reflections).
 * Same tile irradiance, no extra CPU stamp — evaluated in the shader only.
 */
export const MIRROR_STRENGTH = 0.55;
/** Cool blue lamp tint (matches streetlamp material). */
export const LAMP_COLOR = MAT_STREETLAMP.color;

/** Decode scale baked into the RGBA8 lightmap texture. */
export const LIGHT_TEX_SCALE = 2.5;

/** Wet-ground specular strength (shader uniform). */
export const WET_SPECULAR = 0.35;

function falloff(dist, radius) {
  if (dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t;
}

/**
 * Tile lightmap covering [originX, originZ) .. + (w, h).
 * Each tile stores additive RGB irradiance (ambient + lamps).
 */
export class TileLightmap {
  constructor() {
    this.originX = 0;
    this.originZ = 0;
    this.w = 1;
    this.h = 1;
    this.rgb = new Float32Array(3);
    this.rgba = new Uint8Array(4);
  }

  /**
   * Clear to ambient and ensure storage fits the rect.
   * @param {number} x0 inclusive
   * @param {number} z0 inclusive
   * @param {number} x1 exclusive
   * @param {number} z1 exclusive
   */
  begin(x0, z0, x1, z1) {
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, z1 - z0);
    this.originX = x0;
    this.originZ = z0;
    this.w = w;
    this.h = h;
    const n = w * h * 3;
    if (this.rgb.length < n) this.rgb = new Float32Array(n);
    const ar = AMBIENT_LIGHT[0];
    const ag = AMBIENT_LIGHT[1];
    const ab = AMBIENT_LIGHT[2];
    for (let i = 0; i < n; i += 3) {
      this.rgb[i] = ar;
      this.rgb[i + 1] = ag;
      this.rgb[i + 2] = ab;
    }
  }

  /**
   * Add a point light centered on tile (lx, lz) with radial falloff.
   */
  stampLamp(lx, lz, radius = LAMP_RADIUS, color = LAMP_COLOR, intensity = LAMP_INTENSITY) {
    const x0 = Math.max(this.originX, Math.floor(lx - radius));
    const z0 = Math.max(this.originZ, Math.floor(lz - radius));
    const x1 = Math.min(this.originX + this.w, Math.ceil(lx + radius + 1));
    const z1 = Math.min(this.originZ + this.h, Math.ceil(lz + radius + 1));
    const cr = color[0] * intensity;
    const cg = color[1] * intensity;
    const cb = color[2] * intensity;
    const w = this.w;
    const rgb = this.rgb;
    const ox = this.originX;
    const oz = this.originZ;

    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const dist = Math.hypot(x + 0.5 - lx, z + 0.5 - lz);
        const f = falloff(dist, radius);
        if (f <= 0) continue;
        const i = ((z - oz) * w + (x - ox)) * 3;
        rgb[i] += cr * f;
        rgb[i + 1] += cg * f;
        rgb[i + 2] += cb * f;
      }
    }
  }

  /** Pack HDR RGB into RGBA8 for NEAREST sampling (rgb / LIGHT_TEX_SCALE). */
  toTextureBytes() {
    const n = this.w * this.h;
    if (this.rgba.length < n * 4) this.rgba = new Uint8Array(n * 4);
    const rgb = this.rgb;
    const out = this.rgba;
    const scale = 255 / LIGHT_TEX_SCALE;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k = i * 3;
      out[j] = Math.min(255, Math.round(rgb[k] * scale));
      out[j + 1] = Math.min(255, Math.round(rgb[k + 1] * scale));
      out[j + 2] = Math.min(255, Math.round(rgb[k + 2] * scale));
      out[j + 3] = 255;
    }
    return out;
  }
}
