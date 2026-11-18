import { bearing, clamp, haversine, projectOnSegment, type LatLng } from './geo';

/** Where the vehicle should be by now, and how uncertain that guess is (metres). */
export interface ProgressPrediction {
  along: number;
  tolerance: number;
}

export interface RouteMatch {
  /** Index of the segment's first vertex. */
  segment: number;
  /** Position along that segment (0..1). */
  t: number;
  /** Closest point on the route. */
  point: LatLng;
  /** Metres between the query point and the route. */
  distance: number;
  /** Metres from the route start to `point`, measured along the route. */
  along: number;
}

/**
 * An immutable polyline with pre-computed cumulative distances, so "how much
 * road is left from here" is a projection plus one subtraction.
 */
export class RouteLine {
  readonly points: readonly LatLng[];
  /** cumulative[i] = metres from the start to points[i]. */
  readonly cumulative: Float64Array;
  /** Total length in metres. */
  readonly length: number;

  constructor(input: readonly LatLng[]) {
    const points: LatLng[] = [];
    for (const p of input) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      const prev = points[points.length - 1];
      if (prev && prev.lat === p.lat && prev.lng === p.lng) continue;
      points.push({ lat: p.lat, lng: p.lng });
    }
    if (points.length === 0) throw new Error('A route needs at least one valid point');
    if (points.length === 1) points.push({ ...points[0] });

    this.points = points;
    this.cumulative = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      this.cumulative[i] = this.cumulative[i - 1] + haversine(points[i - 1], points[i]);
    }
    this.length = this.cumulative[points.length - 1];
  }

  get start(): LatLng {
    return this.points[0];
  }

  get end(): LatLng {
    return this.points[this.points.length - 1];
  }

  get segmentCount(): number {
    return this.points.length - 1;
  }

  /** Index of the segment that contains the point `along` metres from the start. */
  segmentAt(along: number): number {
    if (along <= 0) return 0;
    if (along >= this.length) return this.segmentCount - 1;
    const c = this.cumulative;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= along) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, this.segmentCount - 1);
  }

  /** The point `along` metres from the start (clamped to the route). */
  pointAt(along: number): LatLng {
    const i = this.segmentAt(along);
    const a = this.points[i];
    const b = this.points[i + 1];
    const segLength = this.cumulative[i + 1] - this.cumulative[i];
    const t = segLength > 0 ? clamp((along - this.cumulative[i]) / segLength, 0, 1) : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  /** Closest point on the whole route. */
  nearest(p: LatLng): RouteMatch {
    return this.match(p, 0, this.length, null, null);
  }

  /**
   * Finds where `p` sits on the route between `fromAlong` and `toAlong`.
   *
   * Each candidate is scored by its distance to `p`, plus a continuity cost
   * for straying from the predicted progress (gentle inside the prediction's
   * tolerance, steep beyond it), plus a penalty when the segment points
   * against the travel `heading`. Where the road passes the same place twice
   * (out-and-back legs, U-turns, loops, hairpins) the distances tie and
   * continuity/heading pick the pass the vehicle is actually on.
   */
  match(
    p: LatLng,
    fromAlong: number,
    toAlong: number,
    prediction: ProgressPrediction | null,
    heading: number | null = null,
  ): RouteMatch {
    const lo = this.segmentAt(Math.min(fromAlong, toAlong));
    const hi = this.segmentAt(Math.max(fromAlong, toAlong));
    let bestScore = Infinity;
    let best: RouteMatch | null = null;
    for (let i = lo; i <= hi; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const proj = projectOnSegment(p, a, b);
      const along = this.cumulative[i] + (this.cumulative[i + 1] - this.cumulative[i]) * proj.t;
      let score = proj.distance;
      if (prediction !== null) {
        const off = Math.abs(along - prediction.along);
        score += 0.15 * off + 0.5 * Math.max(0, off - prediction.tolerance);
      }
      if (heading !== null && this.cumulative[i + 1] - this.cumulative[i] > 1) {
        // 0 when aligned, ~34 m when driving the opposite way; small deviations are free.
        const misalign = (1 - Math.cos(((bearing(a, b) - heading) * Math.PI) / 180)) / 2;
        score += 40 * Math.max(0, misalign - 0.15);
      }
      if (score < bestScore) {
        bestScore = score;
        best = { segment: i, t: proj.t, point: proj.point, distance: proj.distance, along };
      }
    }
    return best!;
  }

  /** Vertices from `along` to the end, starting with the exact point at `along`. */
  sliceFrom(along: number): LatLng[] {
    const i = this.segmentAt(along);
    return [this.pointAt(along), ...this.points.slice(i + 1)];
  }

  /** Vertices from the start up to the exact point at `along`. */
  sliceTo(along: number): LatLng[] {
    const i = this.segmentAt(along);
    return [...this.points.slice(0, i + 1), this.pointAt(along)];
  }
}
