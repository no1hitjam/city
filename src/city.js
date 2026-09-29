export const BLOCKS_X = 100;
export const BLOCKS_Y = 100;
export const BLOCK_W = 24;
export const BLOCK_H = 10;

const STRIDE_X = BLOCK_W + 1;
const STRIDE_Y = BLOCK_H + 1;

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
    cols: BLOCKS_X * STRIDE_X + 1,
    rows: BLOCKS_Y * STRIDE_Y + 1,
  };
}

export function avenueX(index) {
  return index * STRIDE_X;
}

export function streetY(index) {
  return (BLOCKS_Y - index) * STRIDE_Y;
}

export function cellChar(x, y) {
  const onAvenue = x % STRIDE_X === 0;
  const onStreet = y % STRIDE_Y === 0;
  if (onAvenue && onStreet) return "+";
  if (onStreet) return "-";
  if (onAvenue) return "|";
  return " ";
}

export function roadAt(x, y) {
  const map = mapSize();
  if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) {
    return null;
  }

  const onAvenue = x % STRIDE_X === 0;
  const onStreet = y % STRIDE_Y === 0;
  if (!onAvenue && !onStreet) return null;

  const result = { avenue: -1, street: -1 };
  if (onAvenue) result.avenue = x / STRIDE_X;
  if (onStreet) result.street = BLOCKS_Y - y / STRIDE_Y;
  return result;
}

export function roadLabel(road) {
  if (!road) return "";
  const parts = [];
  if (road.street >= 0) parts.push(streetName(road.street));
  if (road.avenue >= 0) parts.push(avenueName(road.avenue));
  return parts.join(" & ");
}
