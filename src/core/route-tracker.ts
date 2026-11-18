import { bearing, clamp, haversine, type LatLng } from './geo';
import type { RouteLine, RouteMatch } from './route-line';

export interface TrackerOptions {
  /** How far behind the last matched position we still search (GPS jitter). */
  backtrackM: number;
  /** Minimum search distance ahead of the last matched position. */
  lookaheadM: number;
  /** Highest plausible vehicle speed, used to widen the window after GPS gaps. */
  maxSpeedMps: number;
  /** Off-route threshold = clamp(accuracy x factor, min, max). */
  offRouteMinM: number;
  offRouteMaxM: number;
  offRouteAccuracyFactor: number;
  /** Fixes up to threshold x this factor still advance progress (parallel service roads). */
  nearRouteFactor: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  backtrackM: 200,
  lookaheadM: 1500,
  maxSpeedMps: 45,
  offRouteMinM: 75,
  offRouteMaxM: 300,
  offRouteAccuracyFactor: 2,
  nearRouteFactor: 2.5,
};

export interface TrackResult {
  /** Metres from the route start to the vehicle's matched position. */
  along: number;
  /** Road metres left until the end of the route. */
  remaining: number;
  /** Where the latest fix matched (may differ from `along` while off-route). */
  matchAlong: number;
  /** Metres between the fix and the route. */
  offRouteBy: number;
  /** Fix is within the off-route threshold. */
  onRoute: boolean;
  /** Fix is close enough that progress along the route was still updated. */
  nearRoute: boolean;
  /** Closest point on the route. */
  snapped: LatLng;
  /** Off-route threshold used for this fix. */
  threshold: number;
}

/**
 * Map-matches a stream of GPS fixes onto a route and keeps track of progress.
 *
 * The search is windowed around the previous position and biased towards the
 * position predicted from the vehicle's recent speed, so progress can't jump
 * to a later (or earlier) pass of the same road.
 */
export class RouteTracker {
  readonly route: RouteLine;
  private readonly opts: TrackerOptions;
  private along = 0;
  private speed = 0;
  private lastTime: number | null = null;
  private matched = false;
  private recent: { p: LatLng; t: number }[] = [];
  private groundSpeed: number | null = null;
  private progressLog: { t: number; along: number }[] = [];

  constructor(route: RouteLine, options: Partial<TrackerOptions> = {}) {
    this.route = route;
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  /** Metres travelled along the route so far. */
  get progress(): number {
    return this.along;
  }

  /**
   * @param heading travel direction in degrees, only when the device reports
   *   one while moving (it disambiguates the two sides of a U-turn).
   * @param deviceSpeed ground speed in m/s if the device reports it.
   */
  update(
    p: LatLng,
    accuracyM: number,
    timestamp: number,
    heading: number | null = null,
    deviceSpeed: number | null = null,
  ): TrackResult {
    const { route, opts } = this;
    const threshold = clamp(
      (Number.isFinite(accuracyM) ? accuracyM : opts.offRouteMaxM) * opts.offRouteAccuracyFactor,
      opts.offRouteMinM,
      opts.offRouteMaxM,
    );
    const dt = this.lastTime === null ? 0 : clamp((timestamp - this.lastTime) / 1000, 0, 6 * 3600);

    // Motion straight from GPS, independent of map matching: if the matcher ever
    // picks the wrong pass of a road, its own progress can't be trusted, but
    // ground speed and a steady travel direction still can.
    const motion = this.motion(p, accuracyM, timestamp);
    heading ??= motion.heading;
    const ground =
      deviceSpeed !== null && Number.isFinite(deviceSpeed) && deviceSpeed >= 0 ? deviceSpeed : motion.speed;
    if (ground !== null) {
      this.groundSpeed = this.groundSpeed === null ? ground : this.groundSpeed * 0.6 + ground * 0.4;
    }
    this.recent.push({ p: { lat: p.lat, lng: p.lng }, t: timestamp });
    while (this.recent.length > 40 || (this.recent.length > 1 && timestamp - this.recent[0].t > 90_000)) {
      this.recent.shift();
    }

    let match: RouteMatch;
    if (!this.matched) {
      match = route.nearest(p);
    } else {
      // Progress is predictable between fixes: anything within the plausible
      // travel since the last fix is cheap, a jump beyond it (to another pass
      // of the same road) must be strongly justified by the GPS position.
      // After long gaps (> 1 min) the vehicle may have stopped or sped up, so
      // the tolerance opens up and position decides.
      const step = (this.groundSpeed ?? this.speed) * dt;
      const tolerance = 30 + 0.5 * step + (dt > 60 ? opts.maxSpeedMps * dt * 0.5 : 0);
      const ahead = Math.max(opts.lookaheadM, opts.maxSpeedMps * dt * 1.25);
      match = route.match(
        p,
        this.along - opts.backtrackM,
        this.along + ahead,
        { along: this.along + step, tolerance },
        heading,
      );
      if (match.distance > threshold) {
        // The window lost us (long GPS gap, a shortcut or a bad first match):
        // trust pure distance over the whole route.
        const global = route.match(p, 0, route.length, null, heading);
        if (global.distance <= threshold) match = global;
      }
    }

    const onRoute = match.distance <= threshold;
    const nearRoute = match.distance <= threshold * opts.nearRouteFactor;
    if (!this.matched || nearRoute) {
      if (this.matched && dt > 0) {
        const v = clamp((match.along - this.along) / dt, 0, opts.maxSpeedMps);
        this.speed = this.speed === 0 ? v : this.speed * 0.6 + v * 0.4;
      }
      this.along = match.along;
      this.matched = true;
    }
    this.lastTime = timestamp;

    if (onRoute) {
      const reanchored = this.escapeWrongPass(p, match.segment, threshold, timestamp);
      if (reanchored) match = reanchored;
    }

    return {
      along: this.along,
      remaining: Math.max(0, route.length - this.along),
      matchAlong: match.along,
      offRouteBy: match.distance,
      onRoute,
      nearRoute,
      snapped: match.point,
      threshold,
    };
  }

  /**
   * Safety net for roads the route uses twice in opposite directions. If the
   * matched position has been sliding backwards while GPS says we're moving,
   * and another pass of the route runs here the other way, we are on that
   * pass. Without this a single bad match at a U-turn could freeze progress
   * and the alarm would never ring.
   */
  private escapeWrongPass(p: LatLng, segment: number, threshold: number, timestamp: number): RouteMatch | null {
    const log = this.progressLog;
    log.push({ t: timestamp, along: this.along });
    while (log.length > 1 && timestamp - log[0].t > 40_000) log.shift();
    if (this.groundSpeed === null || this.groundSpeed < 2 || timestamp - log[0].t < 8_000) return null;
    const slid = Math.max(...log.map((e) => e.along)) - this.along;
    if (slid < Math.max(40, threshold)) return null;

    const { route } = this;
    const alt = route.match(p, this.along + 2 * threshold, route.length, null, null);
    if (alt.distance > threshold) return null;
    const here = bearing(route.points[segment], route.points[segment + 1]);
    const there = bearing(route.points[alt.segment], route.points[alt.segment + 1]);
    if (Math.abs(((here - there + 540) % 360) - 180) < 120) return null;

    this.along = alt.along;
    this.speed = this.groundSpeed;
    this.progressLog = [{ t: timestamp, along: alt.along }];
    return alt;
  }

  /**
   * Ground speed and travel direction from recent fixes, for devices that
   * don't report them. Uses a baseline long enough that GPS jitter can't fake
   * movement, and only reports a direction when the fixes along that baseline
   * form a fairly straight line: a stretch containing a U-turn has a
   * misleading end-to-end direction, so it is ignored.
   */
  private motion(p: LatLng, accuracyM: number, timestamp: number): { heading: number | null; speed: number | null } {
    const baseline = Math.max(40, 3 * Math.min(Number.isFinite(accuracyM) ? accuracyM : 50, 50));
    let k = -1;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const prev = this.recent[i];
      if (timestamp - prev.t > 30_000) {
        // Moved less than the baseline in 30 s: crawling or stopped.
        return { heading: null, speed: 0 };
      }
      if (haversine(prev.p, p) >= baseline) {
        k = i;
        break;
      }
    }
    if (k < 0) return { heading: null, speed: null };

    const start = this.recent[k];
    const chord = haversine(start.p, p);
    const seconds = (timestamp - start.t) / 1000;
    let path = 0;
    for (let i = k; i < this.recent.length; i++) {
      path += haversine(this.recent[i].p, i + 1 < this.recent.length ? this.recent[i + 1].p : p);
    }
    return {
      heading: path > 0 && chord / path >= 0.75 ? bearing(start.p, p) : null,
      speed: seconds > 0 ? chord / seconds : null,
    };
  }
}
