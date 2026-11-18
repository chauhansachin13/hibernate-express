import { describe, expect, it } from 'vitest';
import { haversine } from '../src/core/geo';
import { RouteLine } from '../src/core/route-line';
import { RouteTracker } from '../src/core/route-tracker';
import fixture from './fixtures/hyderabad-warangal.json';
import { gaussianOffset, percentile, rng, walk, WARANGAL } from './helpers';

const real = new RouteLine(fixture.points.map(([lat, lng]) => ({ lat, lng })));

describe('RouteLine', () => {
  it('measures the real Hyderabad to Warangal road within 0.5% of OSRM', () => {
    expect(Math.abs(real.length - fixture.distance) / fixture.distance).toBeLessThan(0.005);
  });

  it('finds the along-route position of points on the route', () => {
    const random = rng(7);
    for (let i = 0; i < 200; i++) {
      const along = random() * real.length;
      const match = real.nearest(real.pointAt(along));
      expect(match.distance).toBeLessThan(0.5);
      expect(Math.abs(match.along - along)).toBeLessThan(1);
    }
  });

  it('splits into travelled and remaining parts that add up', () => {
    const along = real.length * 0.37;
    const len = (pts: { lat: number; lng: number }[]) =>
      pts.slice(1).reduce((sum, p, i) => sum + haversine(pts[i], p), 0);
    expect(len(real.sliceTo(along)) + len(real.sliceFrom(along))).toBeCloseTo(real.length, 0);
    expect(len(real.sliceTo(along))).toBeCloseTo(along, 0);
  });

  it('removes duplicate vertices and survives a single point', () => {
    const line = new RouteLine([WARANGAL, WARANGAL, WARANGAL]);
    expect(line.points).toHaveLength(2);
    expect(line.length).toBe(0);
    expect(line.pointAt(10)).toEqual(WARANGAL);
  });
});

describe('RouteTracker', () => {
  it('follows a noisy drive along the real route', () => {
    const errors: number[] = [];
    for (let seed = 0; seed < 5; seed++) {
      const tracker = new RouteTracker(real);
      const random = rng(3 + seed * 101);
      for (let along = 0, t = 0; along < real.length; along += 25, t += 1000) {
        const fix = gaussianOffset(real.pointAt(along), 12, random);
        errors.push(Math.abs(tracker.update(fix, 15, t).along - along));
      }
    }
    // 99% of fixes land within 40 m of the truth; the worst moments are at
    // city U-turns where the road passes itself within GPS noise.
    expect(percentile(errors, 0.99)).toBeLessThan(40);
    expect(Math.max(...errors)).toBeLessThan(80);
  });

  it('does not jump to the return leg of an out-and-back road', () => {
    // 5 km north, then back 4 km south on the very same road.
    const route = new RouteLine(walk(WARANGAL, [[0, 5000], [180, 4000]]));
    const tracker = new RouteTracker(route);
    const random = rng(11);
    for (let along = 0, t = 0; along <= route.length; along += 20, t += 2000) {
      const r = tracker.update(gaussianOffset(route.pointAt(along), 8, random), 10, t);
      expect(Math.abs(r.along - along)).toBeLessThan(80);
    }
  });

  it('flags fixes far from the road as off-route without losing progress', () => {
    const route = new RouteLine(walk(WARANGAL, [[90, 10_000]]));
    const tracker = new RouteTracker(route);
    tracker.update(route.pointAt(3000), 10, 0);
    const off = tracker.update(
      { lat: route.pointAt(3100).lat + 0.006, lng: route.pointAt(3100).lng },
      10,
      10_000,
    );
    expect(off.onRoute).toBe(false);
    expect(off.offRouteBy).toBeGreaterThan(600);
    expect(off.along).toBeCloseTo(3000, -1);
  });

  it('catches up after a long GPS gap', () => {
    const tracker = new RouteTracker(real);
    tracker.update(real.pointAt(10_000), 10, 0);
    const r = tracker.update(real.pointAt(25_000), 10, 15 * 60_000);
    expect(r.onRoute).toBe(true);
    expect(r.along).toBeCloseTo(25_000, -1);
  });
});
