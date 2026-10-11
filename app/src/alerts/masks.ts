export interface Pt {
  x: number;
  y: number;
}

/** Ray-casting point-in-polygon test (normalized coordinates). */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * True when every observed position of the object lies inside a mask, meaning it never left
 * the ignored area (a swaying tree or the street). Unknown positions never suppress an alert.
 */
export function isMasked(points: Pt[], polygons: Pt[][]): boolean {
  if (!points.length || !polygons.length) return false;
  return points.every((pt) => polygons.some((poly) => poly.length >= 3 && pointInPolygon(pt, poly)));
}
