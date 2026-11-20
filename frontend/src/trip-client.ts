import { api, ApiError, type AlarmReason, type FixPost, type Place, type Snapshot, type TripSettings } from './api';
import type { Fix } from './core/fix';
import { clamp, haversine, type LatLng } from './core/geo';
import { offlineEstimate } from './core/offline-guard';
import { decodePolyline } from './core/polyline';
import { RoutePath } from './core/route-path';
import { LocationWatcher, type LocationError } from './services/location';

/** What the ride screen shows. */
export interface TripState {
  snapshot: Snapshot;
  route: RoutePath | null;
  /** True while the phone is estimating on its own (no contact with the server). */
  offline: boolean;
  /** Effective alarm: the server's, or one the phone rang on its own. */
  ringing: AlarmReason | null;
}

export interface TripClientOptions {
  destination: Place;
  settings: TripSettings;
  demo: boolean;
  origin: LatLng | null;
  /** Continue an existing server trip (after a page reload). */
  resumeId?: string | null;
  onState: (state: TripState) => void;
  onFatal: (message: string) => void;
  onTripId?: (id: string) => void;
}

/** After this long without the server, the phone checks the alarm rules itself… */
const GUARD_AFTER_MS = 3000;
/** …and after this long it says so on screen. */
const OFFLINE_AFTER_MS = 12_000;
/** How often a phone-only trip tries to reach the server. */
const SERVER_RETRY_MS = 15_000;
/** A fix older than this isn't live GPS any more. */
const FIX_STALE_MS = 60_000;
/** Pace measured on the phone is the average speed over this window. */
const PACE_WINDOW_MS = 120_000;
const MAX_QUEUE = 600;

/**
 * Runs one trip against the Java backend: streams GPS fixes in small batches, polls between
 * fixes (the server keeps estimating and can ring without new GPS), and keeps the alarm working
 * without the server — in dead zones, and even when the trip has to start with no signal.
 */
export class TripClient {
  private readonly opts: TripClientOptions;
  private id: string | null = null;
  private routeVersion = -1;
  private route: RoutePath | null = null;
  private last: Snapshot | null = null;
  private lastOkAt = 0;
  private queue: FixPost['fixes'] = [];
  private busy = false;
  private lastPostAt = 0;
  private timer = 0;
  private watcher: LocationWatcher | null = null;
  private latestFix: Fix | null = null;
  private prevFix: Fix | null = null;
  private lastFixAt = 0;
  private speeds: { t: number; v: number }[] = [];
  private stopped = false;

  // The phone's own picture, for when the server can't be reached.
  /** Best known metres left and when (wall clock) it was known. */
  private known: { remaining: number; at: number } | null = null;
  /** Last known position along the server's route, for matching fixes in dead zones. */
  private trackAlong: number | null = null;
  private trackAlongAt = 0;

  // Tracking on the phone alone (no server yet).
  private localOnly = false;
  private nextServerTry = 0;
  private localRoute: RoutePath | null = null;
  private startDirect: number | null = null;

  // Alarm handling that must survive dead zones.
  private localApproach = false;
  private localArrival = false;
  private localRinging: AlarmReason | null = null;
  private localSnoozeUntil = 0;
  private flagsPending = false;
  private pendingAction: 'ack' | 'snooze' | null = null;
  private hideServerRinging = false;

  constructor(opts: TripClientOptions) {
    this.opts = opts;
  }

  get tripId(): string | null {
    return this.id;
  }

  get latest(): Fix | null {
    return this.latestFix;
  }

  /** True while the trip runs on the phone alone because the server can't be reached. */
  get phoneOnly(): boolean {
    return this.localOnly;
  }

  async start(): Promise<void> {
    // GPS first, so nothing is lost while the server answers (or doesn't).
    if (!this.opts.demo) {
      this.watcher = new LocationWatcher();
      this.watcher.start(
        (fix) => this.onFix(fix),
        (err) => this.onGpsError(err),
      );
    }
    if (this.opts.resumeId) {
      this.id = this.opts.resumeId;
      try {
        const snap = await api.trip(this.id, -1);
        if (this.stopped) return;
        this.accept(snap);
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof ApiError && err.status === 404) this.id = null;
        else if (this.canRunOnPhone(err)) this.goLocal();
        else throw err;
      }
    }
    if (!this.id && !this.localOnly) {
      try {
        const created = await api.createTrip({
          destination: this.opts.destination,
          settings: this.opts.settings,
          demo: this.opts.demo,
          origin: this.opts.origin,
        });
        if (this.stopped) {
          // Ended while the server was still setting it up.
          void api.endTrip(created.tripId).catch(() => undefined);
          return;
        }
        this.id = created.tripId;
        this.accept(created.snapshot);
      } catch (err) {
        if (this.stopped) return;
        if (!this.canRunOnPhone(err)) throw err;
        this.goLocal();
      }
    }
    if (this.stopped) return;
    if (this.id && !this.localOnly) this.opts.onTripId?.(this.id);
    this.timer = window.setInterval(() => void this.pump(), this.opts.demo ? 500 : 1000);
    if (this.localOnly) this.localTick();
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.timer);
    this.watcher?.stop();
    if (this.id) void api.endTrip(this.id).catch(() => undefined);
  }

  /** "I'm awake". Works offline too; the server is told when it can be reached. */
  acknowledge(): void {
    this.localRinging = null;
    this.localSnoozeUntil = 0;
    this.hideServerRinging = true;
    this.pendingAction = 'ack';
    this.emitCurrent();
    void this.pump();
  }

  snooze(): void {
    if (this.localRinging) this.localSnoozeUntil = Date.now() + 2 * 60_000;
    this.localRinging = null;
    this.hideServerRinging = true;
    this.pendingAction = 'snooze';
    this.emitCurrent();
    void this.pump();
  }

  /** Live trips can run on the phone when the server is unreachable or failing. */
  private canRunOnPhone(err: unknown): boolean {
    return !this.opts.demo && err instanceof ApiError && (err.status === 0 || err.status >= 500);
  }

  private goLocal(): void {
    this.localOnly = true;
    this.nextServerTry = Date.now() + SERVER_RETRY_MS;
  }

  private onFix(fix: Fix): void {
    this.prevFix = this.latestFix;
    this.latestFix = fix;
    this.lastFixAt = Date.now();
    this.recordSpeed(fix);
    this.queue.push({
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      speed: fix.speed,
      heading: fix.heading,
      timestamp: fix.timestamp,
    });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.localOnly) this.localTick();
    else if (!this.busy && Date.now() - this.lastPostAt > 1500) void this.pump();
  }

  private onGpsError(err: LocationError): void {
    if (err.code === 'denied' || err.code === 'unsupported' || err.code === 'insecure') this.opts.onFatal(err.message);
  }

  /** Speed samples for the phone's own pace estimate (GPS speed, or distance over time). */
  private recordSpeed(fix: Fix): void {
    let v = fix.speed !== null && fix.speed >= 0 ? fix.speed : null;
    const prev = this.prevFix;
    if (v === null && prev) {
      const dt = (fix.timestamp - prev.timestamp) / 1000;
      if (dt >= 1 && fix.accuracy <= 100) v = haversine(prev, fix) / dt;
    }
    if (v === null || v > 70) return;
    this.speeds.push({ t: fix.timestamp, v });
    while (this.speeds.length && fix.timestamp - this.speeds[0].t > PACE_WINDOW_MS) this.speeds.shift();
  }

  private localPace(): number | null {
    if (this.speeds.length < 3) return null;
    return this.speeds.reduce((sum, s) => sum + s.v, 0) / this.speeds.length;
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.localOnly) {
      if (!this.busy && Date.now() >= this.nextServerTry) void this.tryServer();
      this.localTick();
      return;
    }
    // Requests can hang for seconds in a dead zone: the phone's own check never waits for them.
    if (this.last && Date.now() - this.lastOkAt >= GUARD_AFTER_MS) this.guardTick();
    if (this.busy || !this.id) return;
    this.busy = true;
    try {
      if (this.pendingAction) {
        const action = this.pendingAction;
        const snap = action === 'ack' ? await api.ack(this.id, this.routeVersion) : await api.snooze(this.id, this.routeVersion);
        if (this.pendingAction === action) this.pendingAction = null;
        this.hideServerRinging = false;
        this.accept(snap);
        return;
      }
      if (!this.opts.demo && (this.queue.length > 0 || this.flagsPending)) {
        const batch = this.queue.splice(0, 300);
        this.lastPostAt = Date.now();
        try {
          const snap = await api.postFixes(
            this.id,
            {
              sentAt: Date.now(),
              fixes: batch,
              approachFired: this.localApproach || undefined,
              arrivalFired: this.localArrival || undefined,
            },
            this.routeVersion,
          );
          this.flagsPending = false;
          this.accept(snap);
        } catch (err) {
          this.queue.unshift(...batch);
          throw err;
        }
        return;
      }
      this.accept(await api.trip(this.id, this.routeVersion));
    } catch (err) {
      await this.failed(err);
    } finally {
      this.busy = false;
    }
  }

  /** A phone-only trip found the server: hand the trip over (keeping alarms already rung). */
  private async tryServer(): Promise<void> {
    this.nextServerTry = Date.now() + SERVER_RETRY_MS;
    this.busy = true;
    try {
      let snap: Snapshot | null = null;
      if (this.id) {
        try {
          snap = await api.trip(this.id, -1);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
          this.id = null;
        }
      }
      if (!this.id) {
        const fix = this.latestFix;
        const created = await api.createTrip({
          destination: this.opts.destination,
          settings: this.opts.settings,
          demo: false,
          origin: fix ? { lat: fix.lat, lng: fix.lng } : this.opts.origin,
        });
        if (this.stopped) {
          void api.endTrip(created.tripId).catch(() => undefined);
          return;
        }
        this.id = created.tripId;
        snap = created.snapshot;
      }
      if (this.stopped || !snap || !this.id) return;
      this.localOnly = false;
      this.routeVersion = -1;
      this.flagsPending = this.localApproach || this.localArrival;
      // A few recent fixes let the server pick the trip up straight away.
      this.queue = this.queue.slice(-20);
      this.opts.onTripId?.(this.id);
      this.accept(snap);
    } catch {
      // Still no server: keep going on the phone.
    } finally {
      this.busy = false;
    }
  }

  private accept(s: Snapshot): void {
    this.lastOkAt = Date.now();
    if (s.route) {
      this.route = new RoutePath(decodePolyline(s.route.polyline));
      this.routeVersion = s.route.version;
    }
    this.last = s;
    const now = Date.now();
    if (s.remaining !== null) this.known = { remaining: s.remaining, at: now };
    if (s.along !== null) {
      this.trackAlong = s.along;
      this.trackAlongAt = now;
    }
    // The phone already rang this alarm while it was on its own: don't ring it a second time.
    const approachAlarm = s.ringing === 'distance' || s.ringing === 'time' || s.ringing === 'gps-lost';
    if (approachAlarm && this.localApproach && !this.localRinging && !this.pendingAction) {
      this.pendingAction = 'ack';
      this.hideServerRinging = true;
    }
    this.emit(s, false);
  }

  private async failed(err: unknown): Promise<void> {
    if (err instanceof ApiError && err.status === 404) {
      if (this.opts.demo) {
        this.opts.onFatal('This demo ride has ended.');
        return;
      }
      await this.recreate();
    }
    // Other failures: the next tick's guard check covers them.
  }

  /** The server lost the trip (restart or expiry): start a new one that remembers the alarms. */
  private async recreate(): Promise<void> {
    try {
      const fix = this.latestFix;
      const created = await api.createTrip({
        destination: this.opts.destination,
        settings: this.opts.settings,
        demo: false,
        origin: fix ? { lat: fix.lat, lng: fix.lng } : this.opts.origin,
      });
      if (this.last?.approachFired) this.localApproach = true;
      if (this.last?.phase === 'arrived') this.localArrival = true;
      this.flagsPending = this.localApproach || this.localArrival;
      this.id = created.tripId;
      this.routeVersion = -1;
      this.opts.onTripId?.(created.tripId);
      this.accept(created.snapshot);
    } catch {
      // Unreachable too: the guard keeps the alarm working until it's back.
    }
  }

  /** No answer from the server: check the alarm rules on the phone. */
  private guardTick(): void {
    const s = this.last;
    if (!s || s.remaining === null) return;
    this.evaluate(s, Date.now() - this.lastOkAt >= OFFLINE_AFTER_MS);
  }

  /**
   * Metres left from a GPS fix: along the planned road when the fix is on it (matched forward
   * from the last known position, so a road used twice can't confuse it), otherwise the straight
   * line — never longer than the road, so the alarm can only be early.
   */
  private remainingFromFix(fix: Fix): number {
    const direct = haversine(fix, this.opts.destination);
    const route = this.localOnly ? null : this.route;
    if (route && this.trackAlong !== null) {
      const seconds = Math.max(0, (Date.now() - this.trackAlongAt) / 1000);
      const hit = route.locate(fix, this.trackAlong - 150, this.trackAlong + 300 + 45 * seconds);
      if (hit && hit.offBy <= 250) {
        this.trackAlong = hit.along;
        this.trackAlongAt = Date.now();
        return Math.max(0, route.length - hit.along);
      }
    }
    return direct;
  }

  /**
   * A trip running on the phone alone: straight-line distance from GPS. It is never longer than
   * the road, so the distance alarm can only be early, never late.
   */
  private localTick(): void {
    const fix = this.latestFix;
    const now = Date.now();
    if (!fix) {
      this.last = this.blankSnapshot(now);
      this.emit(this.last, true);
      return;
    }
    const direct = haversine(fix, this.opts.destination);
    if (this.startDirect === null) {
      this.startDirect = Math.max(direct, 1);
      this.localRoute = new RoutePath([{ lat: fix.lat, lng: fix.lng }, { lat: this.opts.destination.lat, lng: this.opts.destination.lng }]);
    }
    const base = this.localSnapshot(fix, direct, now);
    this.last = base;
    this.evaluate(base, true);
  }

  private circleRoute: RoutePath | null = null;
  private circleRadius: number | null = null;

  /** The safety circle for the server's current route (worked out once per route). */
  private circle(): number | null {
    const route = this.localOnly ? null : this.route;
    if (route !== this.circleRoute) {
      this.circleRoute = route;
      this.circleRadius = route ? route.safetyCircle(this.opts.destination, this.opts.settings.distanceM) : null;
    }
    return this.circleRadius;
  }

  private evaluate(s: Snapshot, offline: boolean): void {
    const settings = this.opts.settings;
    const now = Date.now();
    const fix = this.latestFix;
    const fresh = fix !== null && now - this.lastFixAt < FIX_STALE_MS;
    const directNow = fresh ? haversine(fix, this.opts.destination) : null;
    let remaining: number;
    let ageMs: number;
    if (fresh) {
      // Live GPS is the best knowledge there is.
      remaining = this.remainingFromFix(fix);
      ageMs = now - this.lastFixAt;
      this.known = { remaining, at: this.lastFixAt };
    } else if (this.known) {
      // No GPS: count forward from the last thing known (demo rides run on a faster clock).
      remaining = this.known.remaining;
      ageMs = (now - this.known.at) * (s.demo ? Math.max(1, s.timeScale) : 1);
    } else {
      return;
    }
    const pace = s.paceMps !== null && s.paceMps > 0.5 ? s.paceMps : this.localPace();
    const g = offlineEstimate({
      remaining,
      ageMs,
      paceMps: pace,
      directNow,
      distanceM: settings.distanceM,
      timeSec: settings.timeMin > 0 ? settings.timeMin * 60 : null,
      arrivalRadiusM: settings.mode === 'rail' ? 400 : 150,
      circleM: this.circle(),
    });
    const before = this.localRinging;
    if (g.arrived && !this.localArrival && s.phase !== 'arrived') {
      this.localArrival = true;
      this.localApproach = true;
      this.localRinging = 'arrival';
      this.flagsPending = true;
    } else if (g.approach && !this.localApproach && !s.approachFired) {
      this.localApproach = true;
      this.localRinging = directNow === null && !this.opts.demo ? 'gps-lost' : g.rule === 'time' ? 'time' : 'distance';
      this.flagsPending = true;
    }
    if (this.localSnoozeUntil && Date.now() >= this.localSnoozeUntil) {
      this.localSnoozeUntil = 0;
      this.localRinging = 'snooze';
    }
    // Brief hiccups keep the server's picture on screen; alarms and real outages show the estimate.
    if (!offline && this.localRinging === before) return;
    const synthetic: Snapshot = {
      ...s,
      route: undefined,
      phase: this.localArrival ? 'arrived' : s.phase,
      remaining: g.remaining,
      etaSec: g.etaSec,
      paceMps: pace,
      remainingIsEstimate: true,
      progress: s.initialRemaining ? clamp(1 - g.remaining / s.initialRemaining, 0, 1) : s.progress,
      approachFired: s.approachFired || this.localApproach,
      gpsLost: !this.opts.demo && !fresh,
      snoozeLeftMs: this.localSnoozeUntil ? Math.max(0, this.localSnoozeUntil - Date.now()) : s.snoozeLeftMs,
      fix: fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed: fix.speed, heading: fix.heading } : s.fix,
      lastFixAgeMs: fix ? Math.max(0, Date.now() - this.lastFixAt) : s.lastFixAgeMs,
    };
    this.emit(synthetic, offline);
  }

  private blankSnapshot(now: number): Snapshot {
    return {
      phase: 'locating',
      mode: this.opts.settings.mode,
      remaining: null,
      remainingIsEstimate: true,
      initialRemaining: null,
      progress: 0,
      alarmProgress: null,
      etaSec: null,
      speedMps: null,
      paceMps: null,
      onRoute: true,
      rerouting: false,
      gpsLost: false,
      lastFixAgeMs: null,
      ringing: null,
      snoozeLeftMs: null,
      approachFired: this.localApproach,
      along: null,
      snapped: null,
      fix: null,
      routeError: null,
      reroutes: 0,
      routeVersion: -1,
      routeKind: 'direct',
      routeProvider: 'phone',
      demo: false,
      timeScale: 1,
      now,
      serverTime: now,
    };
  }

  private localSnapshot(fix: Fix, direct: number, now: number): Snapshot {
    const settings = this.opts.settings;
    const initial = this.startDirect ?? direct;
    const pace = this.localPace();
    return {
      ...this.blankSnapshot(now),
      phase: 'tracking',
      remaining: direct,
      initialRemaining: initial,
      progress: clamp(1 - direct / initial, 0, 1),
      alarmProgress: initial > settings.distanceM ? clamp(1 - settings.distanceM / initial, 0, 1) : null,
      etaSec: pace !== null && pace > 0.5 ? direct / pace : null,
      speedMps: fix.speed ?? this.speeds[this.speeds.length - 1]?.v ?? null,
      paceMps: pace,
      lastFixAgeMs: Math.max(0, now - this.lastFixAt),
      along: Math.max(0, initial - direct),
      fix: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed: fix.speed, heading: fix.heading },
    };
  }

  private emitCurrent(): void {
    if (this.last) this.emit(this.last, this.localOnly || Date.now() - this.lastOkAt >= OFFLINE_AFTER_MS);
  }

  private emit(s: Snapshot, offline: boolean): void {
    const serverRinging = this.hideServerRinging ? null : s.ringing;
    this.opts.onState({
      snapshot: s,
      route: this.localOnly ? this.localRoute : this.route,
      offline,
      ringing: this.localRinging ?? serverRinging,
    });
  }
}
