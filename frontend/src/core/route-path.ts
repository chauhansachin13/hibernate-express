import { haversine, projectOnSegment, type LatLng } from './geo';

/**
 * The road route the server planned. Used to draw it (travelled and remaining parts) and, in
 * dead zones, to measure the road distance left from a GPS fix on the phone itself.
 */
export class RoutePath {
  readonly points: LatLng[];
  readonly cumulative: number[];
  readonly length: number;

  constructor(points: LatLng[]) {
    this.points = points.length > 1 ? points : [...points, ...points];
    this.cumulative = [0];
    for (let i = 1; i < this.points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + haversine(this.points[i - 1], this.points[i]));
    }
    this.length = this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  private segmentAt(along: number): number {
    const c = this.cumulative;
    if (along <= 0) return 0;
    if (along >= this.length) return Math.max(0, c.length - 2);
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= along) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(along: number): LatLng {
    const i = this.segmentAt(along);
    const a = this.points[i];
    const b = this.points[i + 1] ?? a;
    const seg = this.cumulative[i + 1] - this.cumulative[i];
    const t = seg > 0 ? Math.min(1, Math.max(0, (along - this.cumulative[i]) / seg)) : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  split(along: number): { done: LatLng[]; ahead: LatLng[] } {
    const i = this.segmentAt(along);
    const at = this.pointAt(along);
    return { done: [...this.points.slice(0, i + 1), at], ahead: [at, ...this.points.slice(i + 1)] };
  }

  /**
   * Where on the route a GPS fix is, searching only between two along-distances (so a road
   * used twice, out and back, can't snap to the wrong pass). Null when nothing is in range.
   */
  locate(p: LatLng, fromAlong: number, toAlong: number): { along: number; offBy: number } | null {
    let best: { along: number; offBy: number } | null = null;
    const start = this.segmentAt(Math.max(0, fromAlong));
    for (let i = start; i < this.points.length - 1; i++) {
      if (this.cumulative[i] > toAlong) break;
      const proj = projectOnSegment(p, this.points[i], this.points[i + 1]);
      const along = this.cumulative[i] + proj.t * (this.cumulative[i + 1] - this.cumulative[i]);
      if (along < fromAlong || along > toAlong) continue;
      if (!best || proj.distance < best.offBy) best = { along, offBy: proj.distance };
    }
    return best;
  }
}
