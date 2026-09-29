import { MAT_SIDEWALK } from "./materials.js";

export const BLOCKS_X = 100;
export const BLOCKS_Y = 100;
export const BLOCK_W = 72;
export const BLOCK_H = 30;
export const ROAD_W = 3;
export const ROAD_H = 3;

const OUTER_W = BLOCK_W + 2;
const OUTER_H = BLOCK_H + 2;
const SIDEWALK_D = 2;
const INNER_MIN = SIDEWALK_D + 1;
const INNER_MAX_X = OUTER_W - SIDEWALK_D - 2;
const INNER_MAX_Y = OUTER_H - SIDEWALK_D - 2;
export const STRIDE_X = OUTER_W + ROAD_W;
export const STRIDE_Y = OUTER_H + ROAD_H;

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

function sidewalkRoadAt(lx, ly, bx, by) {
  const result = { avenue: -1, street: -1 };
  if (lx <= INNER_MIN) result.avenue = bx;
  if (lx >= INNER_MAX_X) result.avenue = bx + 1;
  if (ly <= INNER_MIN) result.street = by + 1;
  if (ly >= INNER_MAX_Y) result.street = by;
  return result;
}

export function cellChar(x, y) {
  const block = blockLocalAt(x, y);
  if (!block) return " ";

  if (inSidewalk(block.lx, block.ly)) return MAT_SIDEWALK.char;
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
