import { describe, expect, it } from 'vitest';
import { haversine, type LatLng } from '../src/core/geo';
import { RouteLine } from '../src/core/route-line';
import { TripEngine, type RouteData } from '../src/core/trip-engine';
import { fixAt, walk, WARANGAL } from './helpers';

const line = new RouteLine(walk(WARANGAL, [[90, 20_000]], 100));
const routeData: RouteData = {
  points: [...line.points],
  distance: line.length,
  duration: line.length / 15,
  kind: 'road',
  provider: 'test',
};
const settings = { distanceM: 2000, timeSec: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TripEngine', () => {
  it('moves from locating to routing to tracking', async () => {
    const clock = 0;
    const pending = deferred<RouteData>();
    const engine = new TripEngine(line.end, settings, { route: () => pending.promise, now: () => clock });
    expect(engine.snapshot().phase).toBe('locating');
    engine.handleFix(fixAt(line.start, clock));
    expect(engine.snapshot().phase).toBe('routing');
    pending.resolve(routeData);
    await engine.whenIdle();
    const s = engine.snapshot();
    expect(s.phase).toBe('tracking');
    expect(s.routeKind).toBe('road');
    expect(s.remaining).toBeCloseTo(line.length, -1);
  });

  it('falls back to a straight line when routing fails', async () => {
    const engine = new TripEngine(line.end, settings, {
      route: () => Promise.reject(new Error('offline')),
      now: () => 0,
    });
    engine.handleFix(fixAt(line.start, 0));
    await engine.whenIdle();
    const s = engine.snapshot();
    expect(s.routeKind).toBe('direct');
    expect(s.remaining).toBeCloseTo(haversine(line.start, line.end), 0);
    expect(s.routeError).toBe('offline');
  });

  it('uses straight-line distance in train mode without calling the router', () => {
    let calls = 0;
    const engine = new TripEngine(
      line.end,
      settings,
      {
        route: async () => {
          calls++;
          return routeData;
        },
        now: () => 0,
      },
      { mode: 'rail' },
    );
    engine.handleFix(fixAt(line.start, 0));
    expect(calls).toBe(0);
    expect(engine.snapshot().phase).toBe('tracking');
    expect(engine.snapshot().routeKind).toBe('direct');
  });

  it('dead-reckons through a GPS gap and rings early rather than late', () => {
    let clock = 0;
    const engine = new TripEngine(line.end, settings, { route: async () => routeData, now: () => clock }, {}, routeData);
    for (let along = 0; along <= 10_000; along += 75) {
      engine.handleFix(fixAt(line.pointAt(along), clock, 8, 15));
      clock += 5000;
    }
    const before = engine.snapshot().remaining!;
    clock += 9 * 60_000; // nine minutes in a tunnel / dead zone
    engine.tick();
    const s = engine.snapshot();
    expect(s.gpsLost).toBe(true);
    expect(s.remaining!).toBeLessThan(before - 8000);
    expect(s.ringing).toBe('gps-lost');
  });

  it('re-routes when the bus leaves the planned road', async () => {
    let clock = 0;
    let calls = 0;
    const detour = new RouteLine(walk(line.pointAt(5000), [[0, 1500], [90, 15_000], [180, 1500]], 100));
    const provider = async (from: LatLng): Promise<RouteData> => {
      calls++;
      const along = detour.nearest(from).along;
      return {
        points: detour.sliceFrom(along),
        distance: detour.length - along,
        duration: (detour.length - along) / 15,
        kind: 'road',
        provider: 'test',
      };
    };
    const engine = new TripEngine(
      line.end,
      settings,
      { route: provider, now: () => clock, wallNow: () => clock },
      {},
      routeData,
    );
    const truth = new RouteLine([...line.sliceTo(5000), ...detour.points.slice(1)]);
    for (let along = 0; along < truth.length; along += 30) {
      engine.handleFix(fixAt(truth.pointAt(along), clock, 8, 15));
      await engine.whenIdle();
      clock += 2000;
    }
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(engine.snapshot().reroutes).toBeGreaterThanOrEqual(1);
  });

  it('exports and restores alarm state', () => {
    const clock = 0;
    const a = new TripEngine(line.end, settings, { route: async () => routeData, now: () => clock }, {}, routeData);
    a.handleFix(fixAt(line.pointAt(18_500), clock));
    expect(a.snapshot().ringing).toBe('distance');
    a.acknowledge();
    const b = new TripEngine(line.end, settings, { route: async () => routeData, now: () => clock + 1000 }, {}, routeData);
    b.restore(a.exportState());
    b.handleFix(fixAt(line.pointAt(18_600), clock + 1000));
    expect(b.snapshot().ringing).toBeNull();
  });
});
