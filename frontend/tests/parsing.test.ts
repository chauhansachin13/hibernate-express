import { describe, expect, it } from 'vitest';
import { formatAgo, formatDistance, formatDuration, formatSpeed, splitDistance } from '../src/core/format';
import { destinationPoint, haversine } from '../src/core/geo';
import { EARLY_FACTOR, offlineEstimate, type GuardInput } from '../src/core/offline-guard';
import { decodePolyline, encodePolyline } from '../src/core/polyline';
import { RoutePath } from '../src/core/route-path';
import { encodeWav, SOUNDS, synthesize } from '../src/core/sound-synth';

// Trip logic, map matching and coordinate parsing live in the Java backend and are tested
// there (mvn test). These tests cover what the phone still does on its own.

describe('formatting', () => {
  it('formats distances like a dashboard', () => {
    expect(splitDistance(847)).toEqual({ value: '850', unit: 'm' });
    expect(formatDistance(999)).toBe('1.0 km');
    expect(formatDistance(2449)).toBe('2.4 km');
    expect(formatDistance(143_051)).toBe('143 km');
    expect(splitDistance(Number.NaN)).toEqual({ value: '—', unit: '' });
  });

  it('formats durations, speeds and ages', () => {
    expect(formatDuration(30)).toBe('< 1 min');
    expect(formatDuration(1700)).toBe('28 min');
    expect(formatDuration(8000)).toBe('2 h 13 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatSpeed(16.67)).toBe('60 km/h');
    expect(formatAgo(1200)).toBe('just now');
    expect(formatAgo(42_000)).toBe('42 s ago');
  });
});

describe('route geometry from the server', () => {
  it('decodes the Google polyline test vector', () => {
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].lat).toBeCloseTo(38.5, 5);
    expect(points[0].lng).toBeCloseTo(-120.2, 5);
    expect(points[1].lat).toBeCloseTo(40.7, 5);
    expect(points[1].lng).toBeCloseTo(-120.95, 5);
    expect(points[2].lat).toBeCloseTo(43.252, 5);
    expect(points[2].lng).toBeCloseTo(-126.453, 5);
  });

  it('decodes an empty polyline to no points', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('splits the route into travelled and remaining parts at the server progress', () => {
    const a = { lat: 17.385, lng: 78.4867 };
    const b = destinationPoint(a, 90, 1000);
    const c = destinationPoint(b, 0, 1000);
    const path = new RoutePath([a, b, c]);
    expect(path.length).toBeCloseTo(2000, 0);
    const mid = path.pointAt(1500);
    expect(haversine(mid, destinationPoint(b, 0, 500))).toBeLessThan(1);
    const { done, ahead } = path.split(1500);
    expect(done).toHaveLength(3);
    expect(ahead).toHaveLength(2);
    expect(haversine(done[done.length - 1], ahead[0])).toBe(0);
    expect(path.split(-50).done).toHaveLength(2);
    expect(haversine(path.pointAt(5000), c)).toBeLessThan(1e-6);
  });

  it('keeps a one-point route drawable', () => {
    const p = new RoutePath([{ lat: 10, lng: 10 }]);
    expect(p.points).toHaveLength(2);
    expect(p.length).toBe(0);
  });
});

describe('offline safety net', () => {
  const base: GuardInput = {
    remaining: 5000,
    ageMs: 0,
    paceMps: 10,
    directNow: null,
    distanceM: 2000,
    timeSec: null,
    arrivalRadiusM: 150,
  };

  it('counts forward from the last thing known, leaning early', () => {
    const g = offlineEstimate({ ...base, ageMs: 100_000 });
    expect(g.remaining).toBeCloseTo(5000 - 10 * EARLY_FACTOR * 100, 6);
    expect(g.etaSec).toBeCloseTo(g.remaining / 10, 6);
    expect(g.approach).toBe(false);
    expect(g.rule).toBeNull();
  });

  it('is never later than a bus that keeps its pace', () => {
    for (let s = 0; s <= 600; s += 15) {
      const truth = Math.max(0, base.remaining - base.paceMps! * s);
      expect(offlineEstimate({ ...base, ageMs: s * 1000 }).remaining).toBeLessThanOrEqual(truth);
    }
  });

  it('rings the distance rule on time without a connection', () => {
    // 5 km at 10 m/s: the 2 km rule is due after 300 s; the guard rings by ~261 s.
    expect(offlineEstimate({ ...base, ageMs: 250_000 }).approach).toBe(false);
    const g = offlineEstimate({ ...base, ageMs: 262_000 });
    expect(g.approach).toBe(true);
    expect(g.rule).toBe('distance');
  });

  it('rings the time rule from the measured pace', () => {
    const g = offlineEstimate({ ...base, timeSec: 10 * 60 });
    expect(g.etaSec).toBe(500);
    expect(g.approach).toBe(true);
    expect(g.rule).toBe('time');
  });

  it('knows you arrived when GPS puts you at the stop', () => {
    expect(offlineEstimate({ ...base, directNow: 120 }).arrived).toBe(true);
    expect(offlineEstimate({ ...base, directNow: 400, arrivalRadiusM: 400 }).arrived).toBe(true);
    expect(offlineEstimate({ ...base, directNow: 160 }).arrived).toBe(false);
  });

  it('holds the distance while the bus is stopped and never fakes a time alarm', () => {
    const g = offlineEstimate({ ...base, paceMps: 0.2, ageMs: 600_000, timeSec: 30 * 60 });
    expect(g.remaining).toBe(5000);
    expect(g.etaSec).toBeNull();
    expect(g.approach).toBe(false);
  });
});

describe('matching a fix to the route on the phone', () => {
  // An out-and-back road: 1 km north, then back down the same road and 1 km east.
  const a = { lat: 17.98, lng: 79.53 };
  const b = destinationPoint(a, 0, 1000);
  const c = destinationPoint(a, 90, 1000);
  const path = new RoutePath([a, b, a, c]);

  it('finds the road distance travelled', () => {
    const hit = path.locate(destinationPoint(a, 0, 400), 0, 900);
    expect(hit!.along).toBeCloseTo(400, -1);
    expect(hit!.offBy).toBeLessThan(1);
  });

  it('picks the right pass of a road used twice by searching forward only', () => {
    const p = destinationPoint(a, 0, 400);
    // Coming back down the road, the same spot is 1600 m along, not 400.
    expect(path.locate(p, 1300, 2500)!.along).toBeCloseTo(1600, -1);
  });

  it('round-trips the polyline the server sends', () => {
    const back = decodePolyline(encodePolyline([a, b, c]));
    expect(haversine(back[1], b)).toBeLessThan(1.5);
    expect(haversine(back[2], c)).toBeLessThan(1.5);
  });
});

describe('alarm sounds', () => {
  it.each(SOUNDS.map((s) => s.id))('synthesises %s as a loud, clean WAV', (id) => {
    const samples = synthesize(id);
    expect(samples.length).toBeGreaterThan(10_000);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(1);
    const wav = new DataView(encodeWav(samples));
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe('RIFF');
    expect(wav.getUint32(40, true)).toBe(samples.length * 2);
  });
});
