/**
 * Geographic primitives. All distances are in metres, all angles in degrees.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Great-circle distance between two points (haversine formula). */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, clockwise from north, in [0, 360). */
export function bearing(a: LatLng, b: LatLng): number {
  const phi1 = a.lat * RAD;
  const phi2 = b.lat * RAD;
  const dLambda = (b.lng - a.lng) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** The point reached after travelling `distance` metres from `from` on `bearingDeg`. */
export function destinationPoint(from: LatLng, bearingDeg: number, distance: number): LatLng {
  const delta = distance / EARTH_RADIUS_M;
  const theta = bearingDeg * RAD;
  const phi1 = from.lat * RAD;
  const lambda1 = from.lng * RAD;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(clamp(sinPhi2, -1, 1));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  return { lat: phi2 * DEG, lng: ((lambda2 * DEG + 540) % 360) - 180 };
}

export interface SegmentProjection {
  /** Position of the closest point along the segment: 0 = a, 1 = b. */
  t: number;
  /** Closest point on the segment. */
  point: LatLng;
  /** Distance in metres from the query point to the segment. */
  distance: number;
}

/**
 * Projects `p` onto the segment a→b using a local equirectangular frame centred
 * on `p`. For road segments (metres to a few kilometres long) the error is far
 * below GPS noise, and it is ~10x cheaper than spherical cross-track maths.
 */
export function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): SegmentProjection {
  const kx = Math.cos(p.lat * RAD) * RAD * EARTH_RADIUS_M;
  const ky = RAD * EARTH_RADIUS_M;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const dx = (b.lng - a.lng) * kx;
  const dy = (b.lat - a.lat) * ky;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
  return {
    t,
    point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    distance: Math.hypot(ax + dx * t, ay + dy * t),
  };
}

/** True when the value is a usable latitude/longitude pair. */
export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}
