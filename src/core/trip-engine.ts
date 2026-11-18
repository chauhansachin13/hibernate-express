import {
  AlarmPolicy,
  type AlarmPolicyState,
  type AlarmReason,
  type AlarmSettings,
} from './alarm-policy';
import { FixFilter, type Fix } from './fix-filter';
import { clamp, haversine, type LatLng } from './geo';
import { PaceEstimator } from './pace';
import { RouteLine } from './route-line';
import { RouteTracker } from './route-tracker';

export type TravelMode = 'road' | 'rail';

export interface RouteData {
  points: LatLng[];
  /** Metres according to the router (informational; we measure the geometry ourselves). */
  distance: number;
  /** Seconds according to the router. */
  duration: number;
  /** 'road' = real road geometry; 'direct' = straight line (train mode or routing failed). */
  kind: 'road' | 'direct';
  provider: string;
}

export type RouteProvider = (from: LatLng, to: LatLng) => Promise<RouteData>;

export interface EngineDeps {
  /** Fetches a road route. Must reject when no route can be fetched. */
  route: RouteProvider;
  /** Clock for trip logic (simulated during demo rides and tests). */
  now: () => number;
  /** Wall clock used to rate-limit network requests. Defaults to Date.now. */
  wallNow?: () => number;
}

export interface EngineOptions {
  mode: TravelMode;
  /** No GPS for this long counts as "GPS lost" and dead reckoning takes over. */
  gpsLostAfterMs: number;
  /** Off the road for this long before we ask for a new route. */
  rerouteAfterMs: number;
  /** Minimum wall-clock gap between routing requests (public servers). */
  rerouteMinIntervalMs: number;
  /** Longest back-off after failed re-routes. */
  maxRerouteBackoffMs: number;
  /** When stuck on a straight-line fallback, retry the road route this often. */
  roadRetryMs: number;
  /** Buses are slower than the cars routing engines model. */
  busSpeedFactor: number;
  /** Prior speed when the router gave no duration (m/s). */
  fallbackSpeedMps: number;
  /** Prior speed for trains (m/s). */
  railSpeedMps: number;
  /** Dead reckoning assumes you move this much faster than measured, so a GPS gap errs early. */
  deadReckoningFactor: number;
  /** Arrival radius around the stop (metres). */
  arrivalRadiusM: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  mode: 'road',
  gpsLostAfterMs: 60_000,
  rerouteAfterMs: 12_000,
  rerouteMinIntervalMs: 30_000,
  maxRerouteBackoffMs: 5 * 60_000,
  roadRetryMs: 2 * 60_000,
  busSpeedFactor: 0.85,
  fallbackSpeedMps: 25 / 3.6,
  railSpeedMps: 55 / 3.6,
  deadReckoningFactor: 1.15,
  arrivalRadiusM: 150,
};

export type TripPhase = 'locating' | 'routing' | 'tracking' | 'arrived';

export interface TripSnapshot {
  phase: TripPhase;
  mode: TravelMode;
  destination: LatLng;
  route: RouteLine | null;
  routeKind: 'road' | 'direct' | null;
  routeProvider: string | null;
  /** Latest accepted GPS fix. */
  fix: Fix | null;
  /** Fix snapped onto the route. */
  snapped: LatLng | null;
  /** Metres travelled along the current route. */
  along: number;
  /** Best estimate of metres left, or null before the first fix is tracked. */
  remaining: number | null;
  /** `remaining` is approximate (off-route, straight line or dead reckoning). */
  remainingIsEstimate: boolean;
  /** Remaining distance when tracking started (for the progress bar). */
  initialRemaining: number | null;
  /** 0..1 trip progress. */
  progress: number;
  /** 0..1 position on the progress bar where the distance alarm rings. */
  alarmProgress: number | null;
  /** Seconds to arrival, or null while stopped / unknown. */
  etaSec: number | null;
  /** Smoothed ground speed for display (m/s). */
  speedMps: number | null;
  onRoute: boolean;
  rerouting: boolean;
  gpsLost: boolean;
  /** Milliseconds since the last tracked fix. */
  lastFixAgeMs: number | null;
  ringing: AlarmReason | null;
  snoozedUntil: number | null;
  approachFired: boolean;
  /** Last routing failure, if any. */
  routeError: string | null;
  reroutes: number;
}

export interface EngineState {
  alarm: AlarmPolicyState;
  initialRemaining: number | null;
}

/** A straight-line "route" used for trains and when road routing is unavailable. */
export function directRoute(from: LatLng, to: LatLng, speedMps: number): RouteData {
  const distance = haversine(from, to);
  return {
    points: [
      { lat: from.lat, lng: from.lng },
      { lat: to.lat, lng: to.lng },
    ],
    distance,
    duration: distance / speedMps,
    kind: 'direct',
    provider: 'straight-line',
  };
}

/**
 * Turns a stream of GPS fixes into "how far is my stop, when will I get there,
 * and should the alarm ring now". Pure logic: no DOM, timers or network of its
 * own, so the exact same engine runs in the browser and in the accuracy tests.
 */
export class TripEngine {
  readonly destination: LatLng;
  readonly settings: AlarmSettings;
  readonly policy: AlarmPolicy;

  private readonly deps: Required<EngineDeps>;
  private readonly opts: EngineOptions;
  private readonly filter = new FixFilter();
  private readonly listeners = new Set<(snapshot: TripSnapshot) => void>();

  private routeData: RouteData | null = null;
  private routeLine: RouteLine | null = null;
  private tracker: RouteTracker | null = null;
  private pace: PaceEstimator | null = null;

  private lastFix: Fix | null = null;
  private displaySpeed: number | null = null;
  private snapped: LatLng | null = null;
  private along = 0;
  private remainingAtFix: number | null = null;
  private remainingAtFixTime: number | null = null;
  private remainingIsEstimate = false;
  private initialRemaining: number | null = null;
  private onRoute = true;
  private offRouteSince: number | null = null;

  private routing = false;
  private routingPromise: Promise<void> = Promise.resolve();
  private lastRouteAttemptWall = -Infinity;
  private rerouteBackoffMs = 0;
  private reroutes = 0;
  private routeError: string | null = null;
  private disposed = false;

  constructor(
    destination: LatLng,
    settings: AlarmSettings,
    deps: EngineDeps,
    options: Partial<EngineOptions> = {},
    initialRoute?: RouteData,
  ) {
    this.destination = { lat: destination.lat, lng: destination.lng };
    this.settings = { ...settings };
    this.opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
    this.deps = { route: deps.route, now: deps.now, wallNow: deps.wallNow ?? (() => Date.now()) };
    this.policy = new AlarmPolicy(this.settings, { arrivalRadiusM: this.opts.arrivalRadiusM });
    if (initialRoute) this.installRoute(initialRoute);
  }

  /** The route currently used for tracking. */
  get route(): RouteData | null {
    return this.routeData;
  }

  /** Resolves once no routing request is in flight. */
  whenIdle(): Promise<void> {
    return this.routingPromise;
  }

  subscribe(listener: (snapshot: TripSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  handleFix(fix: Fix): void {
    if (this.disposed) return;
    if (this.filter.check(fix) !== 'ok') {
      this.emit();
      return;
    }
    this.updateDisplaySpeed(fix);
    this.lastFix = fix;
    if (!this.routeLine) {
      if (this.opts.mode === 'rail') {
        this.installRoute(directRoute(fix, this.destination, this.opts.railSpeedMps));
      } else {
        if (!this.routing) this.requestRoute(fix, true);
        this.emit();
        return;
      }
    }
    this.track(fix);
  }

  /** Call about once a second: handles GPS loss, snooze expiry and clock-based UI. */
  tick(): void {
    if (this.disposed) return;
    if (this.routeLine && this.remainingAtFix !== null) this.evaluate(this.deps.now());
    else this.emit();
  }

  acknowledge(): void {
    this.policy.acknowledge();
    this.emit();
  }

  snooze(): void {
    this.policy.snooze(this.deps.now());
    this.emit();
  }

  exportState(): EngineState {
    return { alarm: this.policy.exportState(), initialRemaining: this.initialRemaining };
  }

  restore(state: Partial<EngineState>): void {
    if (state.alarm) this.policy.restoreState(state.alarm);
    if (typeof state.initialRemaining === 'number') this.initialRemaining = state.initialRemaining;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  snapshot(): TripSnapshot {
    const now = this.deps.now();
    const est = this.estimate(now);
    const remaining = est?.remaining ?? null;
    const initial = this.initialRemaining;
    const phase: TripPhase = this.policy.arrived
      ? 'arrived'
      : !this.lastFix
        ? 'locating'
        : !this.routeLine || this.remainingAtFix === null
          ? 'routing'
          : 'tracking';
    return {
      phase,
      mode: this.opts.mode,
      destination: this.destination,
      route: this.routeLine,
      routeKind: this.routeData?.kind ?? null,
      routeProvider: this.routeData?.provider ?? null,
      fix: this.lastFix,
      snapped: this.snapped,
      along: this.along,
      remaining,
      remainingIsEstimate: est?.estimated ?? false,
      initialRemaining: initial,
      progress: initial !== null && initial > 0 && remaining !== null ? clamp(1 - remaining / initial, 0, 1) : 0,
      alarmProgress: initial !== null && initial > 0 ? clamp(1 - this.settings.distanceM / initial, 0, 1) : null,
      etaSec: remaining !== null && this.pace ? this.pace.eta(remaining) : null,
      speedMps: this.displaySpeed,
      onRoute: this.onRoute,
      rerouting: this.routing && this.routeLine !== null,
      gpsLost: est?.gpsLost ?? false,
      lastFixAgeMs: this.remainingAtFixTime === null ? null : Math.max(0, now - this.remainingAtFixTime),
      ringing: this.policy.ringing,
      snoozedUntil: this.policy.snoozedUntil,
      approachFired: this.policy.approachFired,
      routeError: this.routeError,
      reroutes: this.reroutes,
    };
  }

  private track(fix: Fix): void {
    const route = this.routeLine!;
    const now = this.deps.now();
    const direct = haversine(fix, this.destination);
    let remaining: number;
    let estimate = false;

    if (this.routeData!.kind === 'direct') {
      // Straight line: a physical lower bound on the distance left, so alarms err early.
      remaining = direct;
      estimate = true;
      this.snapped = { lat: fix.lat, lng: fix.lng };
      this.along = clamp(route.length - direct, 0, route.length);
      this.onRoute = true;
      this.offRouteSince = null;
      this.maybeRetryRoad(fix);
    } else {
      const heading =
        fix.heading !== null && Number.isFinite(fix.heading) && (fix.speed ?? 0) >= 3 ? fix.heading : null;
      const r = this.tracker!.update(fix, fix.accuracy, now, heading, fix.speed);
      this.snapped = r.snapped;
      this.along = r.along;
      if (r.onRoute) {
        remaining = r.remaining;
        this.onRoute = true;
        this.offRouteSince = null;
      } else {
        this.onRoute = false;
        this.offRouteSince ??= now;
        estimate = true;
        if (r.nearRoute) {
          // A noisy fix or a parallel service road: progress along the route still holds.
          remaining = r.remaining;
        } else {
          // Really somewhere else (detour or shortcut) until the re-route arrives.
          // Assume the rest of the trip winds like the rest of the planned route.
          const roadLeft = route.length - r.matchAlong;
          const straightLeft = haversine(route.pointAt(r.matchAlong), route.end);
          const winding = straightLeft > 200 ? clamp(roadLeft / straightLeft, 1, 2.5) : 1.3;
          remaining = Math.max(direct, Math.min(roadLeft + r.offRouteBy, direct * winding));
        }
        this.maybeReroute(fix, now);
      }
    }

    this.remainingAtFix = remaining;
    this.remainingAtFixTime = now;
    this.remainingIsEstimate = estimate;
    if (this.initialRemaining === null) this.initialRemaining = remaining;
    this.pace!.add(now, remaining);
    this.evaluate(now);
  }

  private estimate(now: number): { remaining: number; gpsLost: boolean; estimated: boolean } | null {
    if (this.remainingAtFix === null || this.remainingAtFixTime === null || !this.pace) return null;
    const age = Math.max(0, now - this.remainingAtFixTime);
    if (age < 1500) return { remaining: this.remainingAtFix, gpsLost: false, estimated: this.remainingIsEstimate };
    // Between fixes keep moving at the measured pace, so phones that report
    // GPS only every 5-15 s don't make the alarm late. Once GPS counts as
    // lost, dead reckoning assumes a slightly higher speed to err early.
    const gpsLost = age > this.opts.gpsLostAfterMs;
    const speed = this.pace.alarmSpeed();
    const lostSec = Math.max(0, age - this.opts.gpsLostAfterMs) / 1000;
    const travelled = speed * (age / 1000) + speed * (this.opts.deadReckoningFactor - 1) * lostSec;
    return {
      remaining: Math.max(0, this.remainingAtFix - travelled),
      gpsLost,
      estimated: this.remainingIsEstimate || age > 15_000,
    };
  }

  private evaluate(now: number): void {
    const est = this.estimate(now);
    if (est && this.pace) {
      const etaSec = this.pace.eta(est.remaining, this.pace.alarmSpeed());
      const directDistance =
        this.lastFix && !est.gpsLost ? haversine(this.lastFix, this.destination) : Number.POSITIVE_INFINITY;
      this.policy.evaluate({ now, remaining: est.remaining, etaSec, gpsLost: est.gpsLost, directDistance });
    }
    this.emit();
  }

  private maybeReroute(fix: Fix, now: number): void {
    if (this.routing || this.opts.mode === 'rail') return;
    if (this.offRouteSince === null || now - this.offRouteSince < this.opts.rerouteAfterMs) return;
    const wall = this.deps.wallNow();
    if (wall - this.lastRouteAttemptWall < Math.max(this.opts.rerouteMinIntervalMs, this.rerouteBackoffMs)) return;
    this.requestRoute(fix, false);
  }

  private maybeRetryRoad(fix: Fix): void {
    if (this.routing || this.opts.mode === 'rail') return;
    if (this.deps.wallNow() - this.lastRouteAttemptWall < this.opts.roadRetryMs) return;
    this.requestRoute(fix, false);
  }

  private requestRoute(from: LatLng, initial: boolean): void {
    this.routing = true;
    this.lastRouteAttemptWall = this.deps.wallNow();
    const origin = { lat: from.lat, lng: from.lng };
    this.routingPromise = this.deps
      .route(origin, this.destination)
      .then(
        (data) => {
          if (this.disposed) return;
          this.routeError = null;
          this.rerouteBackoffMs = 0;
          if (!initial) this.reroutes++;
          this.installRoute(data);
        },
        (err: unknown) => {
          if (this.disposed) return;
          this.routeError = err instanceof Error ? err.message : String(err);
          if (initial || !this.routeLine) {
            this.installRoute(directRoute(origin, this.destination, this.opts.fallbackSpeedMps));
          } else {
            this.rerouteBackoffMs = Math.min(
              this.opts.maxRerouteBackoffMs,
              Math.max(60_000, this.rerouteBackoffMs * 2),
            );
          }
        },
      )
      .finally(() => {
        this.routing = false;
        if (this.disposed) return;
        if (this.lastFix && this.routeLine) this.track(this.lastFix);
        else this.emit();
      });
  }

  private installRoute(data: RouteData): void {
    const line = new RouteLine(data.points);
    const previousRemaining = this.remainingAtFix;
    this.routeData = data;
    this.routeLine = line;
    this.tracker = new RouteTracker(line);
    this.onRoute = true;
    this.offRouteSince = null;

    if (!this.pace) {
      this.pace = new PaceEstimator(this.priorSpeed(data));
    } else if (previousRemaining !== null && this.lastFix) {
      // Keep the pace history continuous across the switch to the new route.
      const fresh =
        data.kind === 'road'
          ? line.length - line.nearest(this.lastFix).along
          : haversine(this.lastFix, this.destination);
      this.pace.rebase(fresh - previousRemaining);
    }
  }

  private priorSpeed(data: RouteData): number {
    if (this.opts.mode === 'rail') return this.opts.railSpeedMps;
    if (data.kind === 'road' && data.duration > 0 && data.distance > 0) {
      return (data.distance / data.duration) * this.opts.busSpeedFactor;
    }
    return this.opts.fallbackSpeedMps;
  }

  private updateDisplaySpeed(fix: Fix): void {
    let v: number | null = fix.speed !== null && Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    if (v === null && this.lastFix) {
      const dt = (fix.timestamp - this.lastFix.timestamp) / 1000;
      const moved = haversine(this.lastFix, fix);
      if (dt > 0 && dt < 120) v = moved < fix.accuracy ? 0 : moved / dt;
    }
    if (v === null) return;
    this.displaySpeed = this.displaySpeed === null ? v : this.displaySpeed * 0.5 + v * 0.5;
  }

  private emit(): void {
    if (this.disposed || this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
