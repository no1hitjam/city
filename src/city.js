import { MAT_SIDEWALK, MAT_STREETLAMP, MAT_SKYSCRAPER } from "./materials.js";

export const BLOCKS_X = 100;
export const BLOCKS_Y = 100;
export const BLOCK_W = 72;
export const BLOCK_H = 30;
export const ROAD_W = 3;
export const ROAD_H = 3;

const OUTER_W = BLOCK_W + 2;
const OUTER_H = BLOCK_H + 2;
const SIDEWALK_D = 1;
const LAMP_INTERVAL = 16;
const INNER_MIN = SIDEWALK_D + 1;
const INNER_MAX_X = OUTER_W - SIDEWALK_D - 2;
const INNER_MAX_Y = OUTER_H - SIDEWALK_D - 2;
const LOT_X0 = INNER_MIN + 1;
const LOT_Y0 = INNER_MIN + 1;
const LOT_X1 = INNER_MAX_X;
const LOT_Y1 = INNER_MAX_Y;
const BUILDING_GAP = 1;
const BUILDING_MIN_W = 8;
const BUILDING_MIN_D = 5;
const BUILDING_MAX_W = 40;
export const STRIDE_X = OUTER_W + ROAD_W;
export const STRIDE_Y = OUTER_H + ROAD_H;

const buildingsCache = new Map();

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const ones = n % 10;
  if (ones === 1) return `${n}st`;
  if (ones === 2) return `${n}nd`;
  if (ones === 3) return `${n}rd`;
  return `${n}th`;
}

export function avenueName(index) {
  return `${ordinal(index + 1)} Ave`;
}

export function streetName(index) {
  return `${ordinal(index + 1)} St`;
}

export function mapSize() {
  return {
    cols: BLOCKS_X * OUTER_W + (BLOCKS_X + 1) * ROAD_W,
    rows: BLOCKS_Y * OUTER_H + (BLOCKS_Y + 1) * ROAD_H,
  };
}

function blockOriginX(bx) {
  return ROAD_W + bx * STRIDE_X;
}

function blockOriginY(by) {
  return ROAD_H + (BLOCKS_Y - 1 - by) * STRIDE_Y;
}

export function avenueX(index) {
  if (index <= 0) return 0;
  if (index >= BLOCKS_X) return mapSize().cols - ROAD_W;
  return blockOriginX(index - 1) + OUTER_W;
}

export function streetY(index) {
  if (index <= 0) return mapSize().rows - ROAD_H;
  if (index >= BLOCKS_Y) return 0;
  return blockOriginY(index) + OUTER_H;
}

function blockLocalAt(x, y) {
  const relX = x - ROAD_W;
  const relY = y - ROAD_H;
  if (relX < 0 || relY < 0) return null;

  const bx = Math.floor(relX / STRIDE_X);
  const rowFromNorth = Math.floor(relY / STRIDE_Y);
  if (bx < 0 || bx >= BLOCKS_X || rowFromNorth < 0 || rowFromNorth >= BLOCKS_Y) {
    return null;
  }

  const lx = relX - bx * STRIDE_X;
  const ly = relY - rowFromNorth * STRIDE_Y;
  if (lx >= OUTER_W || ly >= OUTER_H) return null;

  const by = BLOCKS_Y - 1 - rowFromNorth;
  return { bx, by, lx, ly };
}

function inSidewalk(lx, ly) {
  const inLot =
    lx > INNER_MIN &&
    lx < INNER_MAX_X &&
    ly > INNER_MIN &&
    ly < INNER_MAX_Y;
  return !inLot;
}

function isStreetlamp(lx, ly, x, y) {
  const onNorth = ly <= INNER_MIN;
  const onSouth = ly >= INNER_MAX_Y;
  const onWest = lx <= INNER_MIN;
  const onEast = lx >= INNER_MAX_X;
  const northRow = ly === 0;
  const southRow = ly === OUTER_H - 1;
  const westCol = lx === 0;
  const eastCol = lx === OUTER_W - 1;
  const corner = (northRow || southRow) && (westCol || eastCol);

  if ((onNorth && northRow) || (onSouth && southRow)) {
    if (!corner && x % LAMP_INTERVAL === 0) return true;
  }
  if ((onWest && westCol) || (onEast && eastCol)) {
    if (y % LAMP_INTERVAL === 0) return true;
  }
  return false;
}

function sidewalkRoadAt(lx, ly, bx, by) {
  const result = { avenue: -1, street: -1 };
  if (lx <= INNER_MIN) result.avenue = bx;
  if (lx >= INNER_MAX_X) result.avenue = bx + 1;
  if (ly <= INNER_MIN) result.street = by + 1;
  if (ly >= INNER_MAX_Y) result.street = by;
  return result;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blockSeed(bx, by) {
  return (Math.imul(bx + 1, 374761393) ^ Math.imul(by + 1, 668265263)) >>> 0;
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function subdivideX(buildings, rng, x, y, w, d, depth) {
  const canSplit = w >= BUILDING_MIN_W * 2 + BUILDING_GAP;
  const preferLeaf =
    depth > 0 &&
    w <= BUILDING_MAX_W &&
    rng() < 0.75 + depth * 0.15;

  if (preferLeaf || !canSplit) {
    if (w >= BUILDING_MIN_W && d >= BUILDING_MIN_D) {
      buildings.push({ x, y, w, d });
    }
    return;
  }

  const cut = randInt(
    rng,
    BUILDING_MIN_W,
    w - BUILDING_MIN_W - BUILDING_GAP
  );
  subdivideX(buildings, rng, x, y, cut, d, depth + 1);
  subdivideX(
    buildings,
    rng,
    x + cut + BUILDING_GAP,
    y,
    w - cut - BUILDING_GAP,
    d,
    depth + 1
  );
}

function generateBuildings(bx, by) {
  const rng = mulberry32(blockSeed(bx, by));
  const buildings = [];
  const lotW = LOT_X1 - LOT_X0;
  const lotH = LOT_Y1 - LOT_Y0;
  const bands = [];

  if (lotH >= BUILDING_MIN_D * 2 + BUILDING_GAP && rng() < 0.65) {
    const cut = randInt(
      rng,
      BUILDING_MIN_D,
      lotH - BUILDING_MIN_D - BUILDING_GAP
    );
    bands.push({ x: LOT_X0, y: LOT_Y0, w: lotW, d: cut });
    bands.push({
      x: LOT_X0,
      y: LOT_Y0 + cut + BUILDING_GAP,
      w: lotW,
      d: lotH - cut - BUILDING_GAP,
    });
  } else {
    bands.push({ x: LOT_X0, y: LOT_Y0, w: lotW, d: lotH });
  }

  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    subdivideX(buildings, rng, band.x, band.y, band.w, band.d, 0);
  }
  return buildings;
}

export function buildingsForBlock(bx, by) {
  const key = by * BLOCKS_X + bx;
  let buildings = buildingsCache.get(key);
  if (!buildings) {
    buildings = generateBuildings(bx, by);
    buildingsCache.set(key, buildings);
  }
  return buildings;
}

function hitBuilding(b, lx, ly) {
  return lx >= b.x && lx < b.x + b.w && ly >= b.y && ly < b.y + b.d;
}

function buildingCharAt(bx, by, lx, ly) {
  const buildings = buildingsForBlock(bx, by);
  for (let i = 0; i < buildings.length; i++) {
    if (hitBuilding(buildings[i], lx, ly)) return MAT_SKYSCRAPER.char;
  }
  return null;
}

export function cellChar(x, y) {
  const block = blockLocalAt(x, y);
  if (!block) return " ";

  if (inSidewalk(block.lx, block.ly)) {
    if (isStreetlamp(block.lx, block.ly, x, y)) return MAT_STREETLAMP.char;
    return MAT_SIDEWALK.char;
  }

  const building = buildingCharAt(block.bx, block.by, block.lx, block.ly);
  if (building) return building;
  return " ";
}

function roadCorridorAt(x, y) {
  const map = mapSize();
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return null;

  let avenue = -1;
  let street = -1;

  if (x < ROAD_W) {
    avenue = 0;
  } else {
    const relX = x - ROAD_W;
    const bx = Math.floor(relX / STRIDE_X);
    const lx = relX - bx * STRIDE_X;
    if (bx >= BLOCKS_X) avenue = BLOCKS_X;
    else if (lx >= OUTER_W) avenue = bx + 1;
  }

  if (y < ROAD_H) {
    street = BLOCKS_Y;
  } else {
    const relY = y - ROAD_H;
    const rowFromNorth = Math.floor(relY / STRIDE_Y);
    const ly = relY - rowFromNorth * STRIDE_Y;
    if (rowFromNorth >= BLOCKS_Y) street = 0;
    else if (ly >= OUTER_H) street = BLOCKS_Y - 1 - rowFromNorth;
  }

  if (avenue < 0 && street < 0) return null;
  return { avenue, street };
}

export function roadAt(x, y) {
  const map = mapSize();
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) {
    return null;
  }

  const block = blockLocalAt(x, y);
  if (block && inSidewalk(block.lx, block.ly)) {
    return sidewalkRoadAt(block.lx, block.ly, block.bx, block.by);
  }

  return roadCorridorAt(x, y);
}

export function roadLabel(road) {
  if (!road) return "";
  const parts = [];
  if (road.street >= 0) parts.push(streetName(road.street));
  if (road.avenue >= 0) parts.push(avenueName(road.avenue));
  return parts.join(" & ");
}
