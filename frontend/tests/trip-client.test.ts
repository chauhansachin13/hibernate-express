import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../src/api';
import { destinationPoint, haversine, type LatLng } from '../src/core/geo';
import { encodePolyline } from '../src/core/polyline';
import { TripClient, type TripState } from '../src/trip-client';

// The alarm must ring even when the server can't be reached. These tests drive the real trip
// client with a fake clock, fake GPS and a fake (or dead) network.

const STOP = { name: 'NIT Warangal', detail: 'Warangal', lat: 17.9837, lng: 79.5307, kind: 'education' as const };

type Handler = (pos: GeolocationPosition) => void;

let gps: Handler | null = null;
let online = true;
let server: ((method: string, path: string, body: unknown) => unknown) | null = null;

function emit(p: LatLng, speed: number | null): void {
  gps?.({
    coords: { latitude: p.lat, longitude: p.lng, accuracy: 8, speed, heading: null, altitude: null, altitudeAccuracy: null },
    timestamp: Date.now(),
  } as unknown as GeolocationPosition);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T08:00:00Z'));
  gps = null;
  online = true;
  server = null;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    geolocation: {
      watchPosition: (ok: Handler) => {
        gps = ok;
        return 1;
      },
      clearWatch: () => undefined,
    },
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!online || !server) throw new TypeError('Failed to fetch');
    const path = new URL(url, 'http://test').pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(server(init?.method ?? 'GET', path, body)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function snapshot(over: Partial<Snapshot>): Snapshot {
  return {
    phase: 'tracking',
    mode: 'road',
    remaining: 5000,
    remainingIsEstimate: false,
    initialRemaining: 8000,
    progress: 0.3,
    alarmProgress: 0.8,
    etaSec: 500,
    speedMps: 10,
    paceMps: 10,
    onRoute: true,
    rerouting: false,
    gpsLost: false,
    lastFixAgeMs: 0,
    ringing: null,
    snoozeLeftMs: null,
    approachFired: false,
    along: 3000,
    snapped: null,
    fix: null,
    routeError: null,
    reroutes: 0,
    routeVersion: 1,
    routeKind: 'road',
    routeProvider: 'test',
    demo: false,
    timeScale: 1,
    now: Date.now(),
    serverTime: Date.now(),
    ...over,
  };
}

function client(distanceM: number, timeMin: number, states: TripState[]): TripClient {
  return new TripClient({
    destination: STOP,
    settings: { mode: 'road', distanceM, timeMin },
    demo: false,
    origin: null,
    onState: (s) => states.push(s),
    onFatal: (m) => {
      throw new Error(m);
    },
  });
}

const ringing = (states: TripState[]) => states[states.length - 1]?.ringing ?? null;

/** Drives straight at the stop at 20 m/s (a fix every second); the distance of the last fix before the alarm. */
async function driveUntil(states: TripState[], alarm: string, fromM: number, bearing: number): Promise<number | null> {
  for (let d = fromM; d >= 0; d -= 20) {
    emit(destinationPoint(STOP, bearing, d), 20);
    await vi.advanceTimersByTimeAsync(1000);
    if (ringing(states) === alarm) return d;
  }
  return null;
}

describe('alarm without the server', () => {
  it('starts on the phone when there is no signal, and the distance alarm is never late', async () => {
    online = false;
    const states: TripState[] = [];
    const c = client(1000, 0, states);
    await c.start();
    expect(c.phoneOnly).toBe(true);
    const rangAt = await driveUntil(states, 'distance', 3000, 200);
    // Rings in the second the bus reaches 1 km (fixes every 20 m); straight-line distance is
    // never longer than the road, so on a real road this can only be early.
    expect(rangAt).toBeGreaterThanOrEqual(1000);
    expect(rangAt).toBeLessThanOrEqual(1020);
    expect(states.some((s) => s.offline && s.snapshot.routeProvider === 'phone')).toBe(true);
    c.stop();
  });

  it('rings the time rule from the pace the phone measures', async () => {
    online = false;
    const states: TripState[] = [];
    const c = client(500, 5, states);
    await c.start();
    const rangAt = await driveUntil(states, 'time', 8000, 90);
    // 5 minutes at 20 m/s = 6 km.
    expect(rangAt).toBeGreaterThanOrEqual(6000);
    expect(rangAt).toBeLessThanOrEqual(6020);
    c.stop();
  });

  it('hands a phone-only trip to the server once it is reachable, without ringing twice', async () => {
    online = false;
    const states: TripState[] = [];
    const c = client(1000, 0, states);
    await c.start();
    for (let d = 1500; d >= 900; d -= 20) {
      emit(destinationPoint(STOP, 0, d), 20);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ringing(states)).toBe('distance');
    c.acknowledge();
    const posted: { approachFired?: boolean }[] = [];
    let acked = false;
    // The server now answers, still thinking the approach alarm is due.
    server = (method, path, body) => {
      if (method === 'POST' && path === '/api/trips') return { tripId: 'abc', snapshot: snapshot({ remaining: 900, ringing: 'distance' }) };
      if (path.endsWith('/fixes')) posted.push(body as { approachFired?: boolean });
      if (path.endsWith('/ack')) acked = true;
      const done = acked || posted.some((p) => p.approachFired);
      return snapshot({ remaining: 880, ringing: done ? null : 'distance', approachFired: done });
    };
    online = true;
    for (let i = 0; i < 20; i++) {
      emit(destinationPoint(STOP, 0, 880 - i * 20), 20);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(c.phoneOnly).toBe(false);
    expect(c.tripId).toBe('abc');
    expect(posted.some((p) => p.approachFired)).toBe(true);
    expect(states.slice(-10).every((s) => s.ringing === null)).toBe(true);
    c.stop();
  });

  it('rings in a dead zone when GPS still works', async () => {
    const states: TripState[] = [];
    let lastFix: LatLng | null = null;
    server = (method, path, body) => {
      const fixes = (body as { fixes?: LatLng[] } | undefined)?.fixes;
      if (fixes?.length) lastFix = fixes[fixes.length - 1];
      const fix = lastFix ? { ...lastFix, accuracy: 8, speed: 20, heading: null } : null;
      const remaining = lastFix ? haversine(lastFix, STOP) : 5000;
      if (method === 'POST' && path === '/api/trips') return { tripId: 't1', snapshot: snapshot({ remaining, fix }) };
      return snapshot({ remaining, fix, paceMps: 20 });
    };
    const c = client(1000, 0, states);
    await c.start();
    let rangAt: number | null = null;
    for (let d = 4000; d >= 0 && rangAt === null; d -= 20) {
      if (d === 2000) online = false; // the bus enters a dead zone 2 km out
      emit(destinationPoint(STOP, 45, d), 20);
      await vi.advanceTimersByTimeAsync(1000);
      if (ringing(states) === 'distance') rangAt = d;
    }
    expect(rangAt).not.toBeNull();
    expect(rangAt!).toBeGreaterThanOrEqual(1000);
    expect(rangAt!).toBeLessThanOrEqual(1020);
    c.stop();
  });

  it('measures the road distance on the route in a dead zone, not the straight line', async () => {
    // A bent road into the stop: 2 km heading west, then 1 km south to the stop.
    const corner = destinationPoint(STOP, 0, 1000);
    const start = destinationPoint(corner, 90, 2000);
    const road = [start, corner, { lat: STOP.lat, lng: STOP.lng }];
    const states: TripState[] = [];
    server = (method, path) => {
      const s = snapshot({ remaining: 3000, along: 0, paceMps: 20, route: { version: 1, polyline: encodePolyline(road), length: 3000, kind: 'road' } });
      return method === 'POST' && path === '/api/trips' ? { tripId: 't3', snapshot: s } : s;
    };
    const c = client(1500, 0, states);
    await c.start();
    // Dead zone from the start; the bus drives the road and GPS keeps working.
    online = false;
    let rangAtRoad: number | null = null;
    for (let along = 0; along <= 3000 && rangAtRoad === null; along += 20) {
      const p = along <= 2000 ? destinationPoint(start, 270, along) : destinationPoint(corner, 180, along - 2000);
      emit(p, 20);
      await vi.advanceTimersByTimeAsync(1000);
      if (ringing(states) === 'distance') rangAtRoad = 3000 - along;
    }
    // Road distance 1.5 km is 500 m before the corner, where the straight line is only 1.12 km:
    // a straight-line guess would ring ~600 m early. Matching on the route rings on time.
    expect(rangAtRoad).not.toBeNull();
    expect(rangAtRoad!).toBeGreaterThanOrEqual(1500);
    expect(rangAtRoad!).toBeLessThanOrEqual(1540);
    c.stop();
  });

  it('rings early, never late, when both the network and GPS are lost', async () => {
    const states: TripState[] = [];
    server = (method, path) => {
      if (method === 'POST' && path === '/api/trips') return { tripId: 't2', snapshot: snapshot({ remaining: 3000, paceMps: 10 }) };
      return snapshot({ remaining: 3000, paceMps: 10 });
    };
    const c = client(1000, 0, states);
    await c.start();
    await vi.advanceTimersByTimeAsync(1000);
    online = false; // tunnel: no network, no GPS; the bus keeps going at 10 m/s
    let rangAfter: number | null = null;
    for (let t = 1; t <= 300 && rangAfter === null; t++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (ringing(states) !== null) rangAfter = t;
    }
    // Truth: 2000 m more at 10 m/s = 200 s. The phone counts down 15% faster.
    expect(rangAfter).not.toBeNull();
    expect(rangAfter!).toBeLessThanOrEqual(200);
    expect(rangAfter!).toBeGreaterThanOrEqual(170);
    c.stop();
  });
});
