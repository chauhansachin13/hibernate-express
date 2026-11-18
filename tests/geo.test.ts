import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  bearing,
  destinationPoint,
  haversine,
  isValidLatLng,
  projectOnSegment,
} from '../src/core/geo';
import { WARANGAL } from './helpers';

describe('haversine', () => {
  it('measures one degree of latitude as pi/180 x R', () => {
    const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeCloseTo((Math.PI / 180) * EARTH_RADIUS_M, 3);
  });

  it('is symmetric and zero for identical points', () => {
    const a = { lat: 17.385, lng: 78.4867 };
    expect(haversine(a, WARANGAL)).toBeCloseTo(haversine(WARANGAL, a), 6);
    expect(haversine(a, a)).toBe(0);
  });
});

describe('destinationPoint and bearing', () => {
  it('round-trips distance and bearing', () => {
    for (const brg of [0, 45, 90, 137, 200, 315]) {
      const p = destinationPoint(WARANGAL, brg, 12_345);
      expect(haversine(WARANGAL, p)).toBeCloseTo(12_345, 2);
      expect(bearing(WARANGAL, p)).toBeCloseTo(brg, 2);
    }
  });
});

describe('projectOnSegment', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 0, lng: 0.01 };

  it('drops a perpendicular onto the segment', () => {
    const p = { lat: 0.001, lng: 0.005 };
    const proj = projectOnSegment(p, a, b);
    expect(proj.t).toBeCloseTo(0.5, 6);
    expect(proj.distance).toBeCloseTo(haversine(p, { lat: 0, lng: 0.005 }), 1);
  });

  it('clamps to the segment ends', () => {
    expect(projectOnSegment({ lat: 0, lng: 0.02 }, a, b).t).toBe(1);
    expect(projectOnSegment({ lat: 0, lng: -0.02 }, a, b).t).toBe(0);
  });

  it('handles zero-length segments', () => {
    const proj = projectOnSegment({ lat: 0.001, lng: 0 }, a, a);
    expect(proj.t).toBe(0);
    expect(proj.distance).toBeCloseTo(111.19, 1);
  });
});

describe('isValidLatLng', () => {
  it('accepts real coordinates and rejects garbage', () => {
    expect(isValidLatLng(WARANGAL)).toBe(true);
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: NaN, lng: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
  });
});
