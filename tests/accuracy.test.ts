/**
 * End-to-end accuracy simulation.
 *
 * A virtual bus drives a route with a known speed profile. Every few seconds
 * it reports a GPS fix with Gaussian noise, exactly like a phone would, and
 * the real TripEngine decides when to ring. Because we know the ground truth
 * we can measure how far from the stop (or how many seconds before it) the
 * alarm actually fired.
 *
 * Run `npm run accuracy` to regenerate docs/ACCURACY.md from these numbers.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { AlarmReason } from '../src/core/alarm-policy';
import type { LatLng } from '../src/core/geo';
import { RouteLine } from '../src/core/route-line';
import { TripEngine, type RouteData, type RouteProvider } from '../src/core/trip-engine';
import fixture from './fixtures/hyderabad-warangal.json';
import { gaussianOffset, percentile, rng, walk, WARANGAL } from './helpers';

const REAL = new RouteLine(fixture.points.map(([lat, lng]) => ({ lat, lng })));
const KMH = 1 / 3.6;

type SpeedProfile = (tSec: number, remaining: number) => number;

interface Scenario {
  name: string;
  route: RouteLine;
  /** Route the engine is given at the start (defaults to `route`). */
  plannedRoute?: RouteLine;
  provider?: RouteProvider;
  startRemaining: number;
  distanceM: number;
  timeSec: number | null;
  intervalSec: number;
  noiseM: number;
  speed: SpeedProfile;
  dropout?: { fromRemaining: number; durationSec: number };
  rides: number;
}

interface Ride {
  fired: boolean;
  reason: AlarmReason | null;
  /** True road metres left when the alarm rang. */
  trueRemaining: number;
  /** True seconds left when the alarm rang. */
  trueSecondsLeft: number;
  reroutes: number;
}

function routeData(line: RouteLine): RouteData {
  return { points: [...line.points], distance: line.length, duration: line.length / (40 * KMH), kind: 'road', provider: 'sim' };
}

function secondsLeft(route: RouteLine, speed: SpeedProfile, t0: number, along0: number): number {
  let t = t0;
  let along = along0;
  while (along < route.length && t - t0 < 6 * 3600) {
    along += speed(t, route.length - along);
    t += 1;
  }
  return t - t0;
}

async function ride(sc: Scenario, seed: number): Promise<Ride> {
  const random = rng(seed);
  const truth = sc.route;
  const planned = sc.plannedRoute ?? truth;
  const data = routeData(planned);
  let clock = 1_800_000_000_000;
  const engine = new TripEngine(
    truth.end,
    { distanceM: sc.distanceM, timeSec: sc.timeSec },
    { route: sc.provider ?? (async () => data), now: () => clock, wallNow: () => clock },
    { mode: 'road' },
    data,
  );
  let along = Math.max(0, truth.length - sc.startRemaining);
  let t = 0;
  let dropoutStart: number | null = null;

  // One iteration = one second, like the app: a GPS fix every `intervalSec`,
  // and the engine's once-a-second tick in between.
  for (let guard = 0; guard < 500_000; guard++) {
    const remaining = truth.length - along;
    const v = sc.speed(t, remaining);
    if (sc.dropout && dropoutStart === null && remaining <= sc.dropout.fromRemaining) dropoutStart = t;
    const inDropout = sc.dropout && dropoutStart !== null && t - dropoutStart < sc.dropout.durationSec;

    if (t % sc.intervalSec === 0 && !inDropout) {
      const p = gaussianOffset(truth.pointAt(along), sc.noiseM, random);
      engine.handleFix({ lat: p.lat, lng: p.lng, accuracy: Math.max(5, sc.noiseM * 1.5), speed: v, heading: null, timestamp: clock });
      await engine.whenIdle();
    }
    engine.tick();
    const s = engine.snapshot();
    if (s.ringing) {
      return {
        fired: true,
        reason: s.ringing,
        trueRemaining: remaining,
        trueSecondsLeft: secondsLeft(truth, sc.speed, t, along),
        reroutes: s.reroutes,
      };
    }
    if (along >= truth.length) break;
    along = Math.min(truth.length, along + v);
    t += 1;
    clock += 1000;
  }
  return { fired: false, reason: null, trueRemaining: NaN, trueSecondsLeft: NaN, reroutes: 0 };
}

async function run(sc: Scenario): Promise<Ride[]> {
  const out: Ride[] = [];
  for (let i = 0; i < sc.rides; i++) out.push(await ride(sc, 1000 + i * 7919));
  return out;
}

// ---------- speed profiles ----------
const constant = (kmh: number): SpeedProfile => () => kmh * KMH;
/** City bus: 90 s moving at 30 km/h, then a 30 s signal or bus stop. */
const stopAndGo: SpeedProfile = (t) => (t % 120 < 90 ? 30 * KMH : 0);
/** Highway at 70 km/h, then city traffic at 25 km/h for the last 6 km. */
const highwayThenCity: SpeedProfile = (_t, remaining) => (remaining > 6000 ? 70 : 25) * KMH;
/** Crawling out of a city at 20 km/h, then 70 km/h on the highway for the last 15 km. */
const cityThenHighway: SpeedProfile = (_t, remaining) => (remaining > 15_000 ? 20 : 70) * KMH;

// ---------- routes ----------
/** 5 km north and 4 km back on the same road: a naive matcher would ring 4 km early. */
const OUT_AND_BACK = new RouteLine(walk(WARANGAL, [[0, 5000], [180, 4000]]));
/** Planned: 20 km east. Actual: the bus detours north and arrives from the north. */
const PLANNED = new RouteLine(walk(WARANGAL, [[90, 20_000]], 100));
const DETOUR_TAIL = new RouteLine(walk(PLANNED.pointAt(6000), [[0, 2500], [90, 14_000], [180, 2500]], 100));
const DETOUR = new RouteLine([...PLANNED.sliceTo(6000), ...DETOUR_TAIL.points.slice(1)]);
const detourProvider: RouteProvider = async (from: LatLng) => {
  const along = DETOUR.nearest(from).along;
  return { points: DETOUR.sliceFrom(along), distance: DETOUR.length - along, duration: (DETOUR.length - along) / (40 * KMH), kind: 'road', provider: 'sim' };
};

interface Row {
  scenario: string;
  rides: number;
  fired: number;
  metric: 'metres' | 'seconds';
  target: number;
  median: number;
  p5: number;
  p95: number;
  worstLate: number;
  note: string;
}
const rows: Row[] = [];

function summarise(sc: Scenario, results: Ride[], metric: Row['metric'], note: string): number[] {
  const target = metric === 'metres' ? sc.distanceM : sc.timeSec!;
  const errors = results
    .filter((r) => r.fired)
    .map((r) => (metric === 'metres' ? r.trueRemaining - target : r.trueSecondsLeft - target));
  rows.push({
    scenario: sc.name,
    rides: results.length,
    fired: results.filter((r) => r.fired).length,
    metric,
    target,
    median: percentile(errors, 0.5),
    p5: percentile(errors, 0.05),
    p95: percentile(errors, 0.95),
    worstLate: Math.min(0, ...errors),
    note,
  });
  return errors;
}

const DISTANCE_CASES: (Scenario & { lateBudget: number; earlyBudget: number; note: string })[] = [
  {
    name: 'Highway 60 km/h, fix every 1 s, ±10 m GPS',
    route: REAL, startRemaining: 25_000, distanceM: 2000, timeSec: null, intervalSec: 1, noiseM: 10,
    speed: constant(60), rides: 40, lateBudget: 60, earlyBudget: 45, note: 'Good phone, open sky',
  },
  {
    name: 'Highway 60 km/h, fix every 5 s, ±20 m GPS',
    route: REAL, startRemaining: 25_000, distanceM: 2000, timeSec: null, intervalSec: 5, noiseM: 20,
    speed: constant(60), rides: 40, lateBudget: 140, earlyBudget: 80, note: 'Battery-saving GPS',
  },
  {
    name: 'Highway 80 km/h, fix every 15 s, ±40 m GPS',
    route: REAL, startRemaining: 25_000, distanceM: 2000, timeSec: null, intervalSec: 15, noiseM: 40,
    speed: constant(80), rides: 40, lateBudget: 420, earlyBudget: 150, note: 'Cheap phone, sparse fixes',
  },
  {
    name: 'City stop-and-go (30 km/h + 30 s stops), fix every 3 s, ±15 m',
    route: REAL, startRemaining: 12_000, distanceM: 1000, timeSec: null, intervalSec: 3, noiseM: 15,
    speed: stopAndGo, rides: 40, lateBudget: 70, earlyBudget: 60, note: 'Signals and bus stops',
  },
  {
    name: 'Out-and-back road (same road twice), 40 km/h, ±10 m',
    route: OUT_AND_BACK, startRemaining: Infinity, distanceM: 2000, timeSec: null, intervalSec: 2, noiseM: 10,
    speed: constant(40), rides: 200, lateBudget: 60, earlyBudget: 45, note: 'Map-matching continuity + wrong-pass recovery',
  },
  {
    name: 'Bus leaves the planned road (re-route), 50 km/h, ±10 m',
    route: DETOUR, plannedRoute: PLANNED, provider: detourProvider, startRemaining: Infinity, distanceM: 2000,
    timeSec: null, intervalSec: 2, noiseM: 10, speed: constant(50), rides: 30, lateBudget: 70, earlyBudget: 45,
    note: 'Off-route detection + OSRM re-route',
  },
];

describe('alarm accuracy: distance rule', () => {
  for (const sc of DISTANCE_CASES) {
    it(sc.name, async () => {
      const results = await run(sc);
      const errors = summarise(sc, results, 'metres', sc.note);
      expect(results.every((r) => r.fired && r.reason === 'distance')).toBe(true);
      for (const e of errors) {
        expect(e).toBeGreaterThan(-sc.lateBudget);
        expect(e).toBeLessThan(sc.earlyBudget);
      }
      if (sc.provider) expect(results.every((r) => r.reroutes >= 1)).toBe(true);
    });
  }

  it('GPS dead zone: 5 minutes without signal from 6 km out', async () => {
    const sc: Scenario = {
      name: 'GPS dead zone: no signal for 5 min starting 6 km out, 60 km/h',
      route: REAL, startRemaining: 25_000, distanceM: 2000, timeSec: null, intervalSec: 1, noiseM: 10,
      speed: constant(60), dropout: { fromRemaining: 6000, durationSec: 300 }, rides: 30,
    };
    const results = await run(sc);
    const errors = summarise(sc, results, 'metres', 'Dead reckoning rings early (safe side)');
    // Without dead reckoning the alarm could only ring when GPS returns, 1 km from the stop.
    expect(results.every((r) => r.fired && r.reason === 'gps-lost')).toBe(true);
    for (const e of errors) {
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThan(1200);
    }
  });
});

const TIME_CASES: (Scenario & { lateBudget: number; earlyBudget: number; note: string })[] = [
  {
    name: '10-min alarm, steady 60 km/h, fix every 1 s',
    route: REAL, startRemaining: 40_000, distanceM: 300, timeSec: 600, intervalSec: 1, noiseM: 10,
    speed: constant(60), rides: 30, lateBudget: 15, earlyBudget: 30, note: 'Steady highway',
  },
  {
    name: '10-min alarm, highway 70 km/h then city 25 km/h for the last 6 km',
    route: REAL, startRemaining: 40_000, distanceM: 300, timeSec: 600, intervalSec: 2, noiseM: 15,
    speed: highwayThenCity, rides: 30, lateBudget: 30, earlyBudget: 600,
    note: 'Bus slows after the alarm: rings early, never late',
  },
  {
    name: '10-min alarm, city 20 km/h then highway 70 km/h for the last 15 km',
    route: REAL, startRemaining: 25_000, distanceM: 300, timeSec: 600, intervalSec: 2, noiseM: 15,
    speed: cityThenHighway, rides: 30, lateBudget: 75, earlyBudget: 60,
    note: 'Bus speeds up: short window reacts in ~2 min',
  },
  {
    name: '10-min alarm, city stop-and-go, fix every 3 s',
    route: REAL, startRemaining: 15_000, distanceM: 300, timeSec: 600, intervalSec: 3, noiseM: 15,
    speed: stopAndGo, rides: 30, lateBudget: 60, earlyBudget: 150, note: 'Signals and bus stops',
  },
];

describe('alarm accuracy: time rule', () => {
  for (const sc of TIME_CASES) {
    it(sc.name, async () => {
      const results = await run(sc);
      const errors = summarise(sc, results, 'seconds', sc.note);
      expect(results.every((r) => r.fired && r.reason === 'time')).toBe(true);
      for (const e of errors) {
        expect(e).toBeGreaterThan(-sc.lateBudget);
        expect(e).toBeLessThan(sc.earlyBudget);
      }
    });
  }
});

afterAll(() => {
  if (!process.env.HX_WRITE_REPORT) return;
  const fmt = (v: number, metric: Row['metric']) =>
    Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Math.round(v)} ${metric === 'metres' ? 'm' : 's'}` : '—';
  const lines = [
    '# Alarm accuracy report',
    '',
    'Generated by `npm run accuracy` (tests/accuracy.test.ts). Each row simulates many rides with',
    'Gaussian GPS noise on a real OSRM road route (Hyderabad MGBS → Hanamkonda, 143 km) or a',
    'synthetic edge case, feeding fixes into the same `TripEngine` the app uses.',
    '',
    '**Error = where the alarm actually rang minus where it should ring.** Positive means it rang',
    'early (you get a little extra time), negative means late.',
    '',
    '| Scenario | Rides | Rang | Target | Median error | 5th–95th percentile | Worst late | Notes |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.scenario} | ${r.rides} | ${r.fired}/${r.rides} | ${r.metric === 'metres' ? `${r.target / 1000} km left` : `${r.target / 60} min left`} | ${fmt(r.median, r.metric)} | ${fmt(r.p5, r.metric)} … ${fmt(r.p95, r.metric)} | ${r.worstLate === 0 ? 'never late' : fmt(r.worstLate, r.metric)} | ${r.note} |`,
    ),
    '',
    'How to read it: with a fix every second the alarm rings within a few tens of metres of the',
    'chosen point. Sparse fixes add at most one reporting interval of travel (e.g. 15 s at 80 km/h',
    '≈ 330 m). Time-based alarms use the measured pace of the bus, so a bus that slows down near',
    'the stop gets woken up early rather than late.',
    '',
  ];
  writeFileSync(new URL('../docs/ACCURACY.md', import.meta.url), lines.join('\n'));
});
