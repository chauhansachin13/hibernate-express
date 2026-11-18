import { describe, expect, it } from 'vitest';
import { AlarmPolicy, type AlarmInput } from '../src/core/alarm-policy';
import { FixFilter } from '../src/core/fix-filter';
import { PaceEstimator } from '../src/core/pace';
import { fixAt, WARANGAL } from './helpers';
import { destinationPoint } from '../src/core/geo';

describe('PaceEstimator', () => {
  it('uses the prior until history exists, then the measured pace', () => {
    const pace = new PaceEstimator(10);
    expect(pace.speed()).toBe(10);
    for (let t = 0; t <= 6 * 60_000; t += 5000) pace.add(t, 20_000 - 15 * (t / 1000));
    expect(pace.speed()).toBeCloseTo(15, 5);
    expect(pace.eta(9000)).toBeCloseTo(600, 3);
  });

  it('blends prior and measurement while history is short', () => {
    const pace = new PaceEstimator(10);
    for (let t = 0; t <= 150_000; t += 5000) pace.add(t, 20_000 - 20 * (t / 1000));
    const s = pace.speed();
    expect(s).toBeGreaterThan(10);
    expect(s).toBeLessThan(20);
  });

  it('reports an unknown ETA while stopped', () => {
    const pace = new PaceEstimator(10);
    for (let t = 0; t <= 9 * 60_000; t += 5000) pace.add(t, 5000);
    expect(pace.eta(5000)).toBeNull();
  });

  it('alarm speed reacts to a recent speed-up', () => {
    const pace = new PaceEstimator(5);
    let rem = 30_000;
    for (let t = 0; t <= 8 * 60_000; t += 5000) {
      rem -= (t < 6 * 60_000 ? 5 : 20) * 5;
      pace.add(t, rem);
    }
    expect(pace.alarmSpeed()).toBeGreaterThan(pace.speed());
  });

  it('rebases history after a re-route', () => {
    const pace = new PaceEstimator(10);
    pace.add(0, 10_000);
    pace.add(60_000, 9_400);
    pace.rebase(500);
    pace.add(120_000, 9_300);
    expect(pace.observed()?.speed).toBeCloseTo(10, 5);
  });
});

describe('AlarmPolicy', () => {
  const base: AlarmInput = { now: 0, remaining: 10_000, etaSec: 1200, gpsLost: false, directDistance: 8000 };

  it('rings once by distance, then again on arrival', () => {
    const policy = new AlarmPolicy({ distanceM: 2000, timeSec: null });
    expect(policy.evaluate(base)).toBeNull();
    expect(policy.evaluate({ ...base, remaining: 1990 })).toBe('distance');
    policy.acknowledge();
    expect(policy.evaluate({ ...base, remaining: 1500 })).toBeNull();
    expect(policy.ringing).toBeNull();
    expect(policy.evaluate({ ...base, remaining: 120, directDistance: 110 })).toBe('arrival');
    expect(policy.arrived).toBe(true);
  });

  it('rings by time when that comes first', () => {
    const policy = new AlarmPolicy({ distanceM: 1000, timeSec: 600 });
    expect(policy.evaluate({ ...base, remaining: 6000, etaSec: 610 })).toBeNull();
    expect(policy.evaluate({ ...base, remaining: 5900, etaSec: 590 })).toBe('time');
  });

  it('ignores the time rule while the ETA is unknown', () => {
    const policy = new AlarmPolicy({ distanceM: 1000, timeSec: 600 });
    expect(policy.evaluate({ ...base, remaining: 3000, etaSec: null })).toBeNull();
  });

  it('snoozes for two minutes', () => {
    const policy = new AlarmPolicy({ distanceM: 2000, timeSec: null });
    policy.evaluate({ ...base, remaining: 1900 });
    policy.snooze(1000);
    expect(policy.ringing).toBeNull();
    expect(policy.evaluate({ ...base, now: 100_000, remaining: 1500 })).toBeNull();
    expect(policy.evaluate({ ...base, now: 121_000, remaining: 1200 })).toBe('snooze');
  });

  it('labels alarms raised by dead reckoning and never fakes arrival', () => {
    const policy = new AlarmPolicy({ distanceM: 2000, timeSec: null });
    expect(policy.evaluate({ ...base, remaining: 100, gpsLost: true, directDistance: Infinity })).toBe('gps-lost');
    expect(policy.arrived).toBe(false);
  });

  it('restores state without resuming a ring', () => {
    const policy = new AlarmPolicy({ distanceM: 2000, timeSec: null });
    policy.evaluate({ ...base, remaining: 1000 });
    const copy = new AlarmPolicy({ distanceM: 2000, timeSec: null });
    copy.restoreState(policy.exportState());
    expect(copy.ringing).toBeNull();
    expect(copy.approachFired).toBe(true);
    expect(copy.evaluate({ ...base, remaining: 900 })).toBeNull();
  });
});

describe('FixFilter', () => {
  it('rejects stale, inaccurate and teleporting fixes', () => {
    const filter = new FixFilter();
    expect(filter.check(fixAt(WARANGAL, 1000))).toBe('ok');
    expect(filter.check(fixAt(WARANGAL, 1000))).toBe('stale');
    expect(filter.check(fixAt(WARANGAL, 2000, 900))).toBe('inaccurate');
    const far = destinationPoint(WARANGAL, 90, 5000);
    expect(filter.check(fixAt(far, 3000))).toBe('jump');
    expect(filter.check(fixAt(destinationPoint(WARANGAL, 90, 20), 4000))).toBe('ok');
  });

  it('accepts a persistent new position after repeated jumps', () => {
    const filter = new FixFilter();
    filter.check(fixAt(WARANGAL, 0));
    const far = destinationPoint(WARANGAL, 0, 8000);
    const verdicts = [1, 2, 3, 4].map((i) => filter.check(fixAt(far, i * 1000)));
    expect(verdicts).toEqual(['jump', 'jump', 'jump', 'ok']);
  });

  it('accepts poor fixes when nothing better arrives for a while', () => {
    const filter = new FixFilter();
    filter.check(fixAt(WARANGAL, 0));
    expect(filter.check(fixAt(WARANGAL, 60_000, 400))).toBe('ok');
  });
});
