import { describe, expect, it } from 'vitest';
import { parseCoordinates } from '../src/core/coords';
import { formatDistance, formatDuration, formatSpeed, splitDistance } from '../src/core/format';
import { encodeWav, SOUNDS, synthesize } from '../src/core/sound-synth';

const ok = (input: string) => {
  const r = parseCoordinates(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error}`);
  return r.value;
};

describe('parseCoordinates', () => {
  it.each([
    ['17.9833, 79.5308', 17.9833, 79.5308],
    ['17.9833 79.5308', 17.9833, 79.5308],
    ['-33.8688,151.2093', -33.8688, 151.2093],
    [`17°58'59.9"N 79°31'50.9"E`, 17.98331, 79.53081],
    ['17.98 N, 79.53 E', 17.98, 79.53],
    ['N 17.98 E 79.53', 17.98, 79.53],
    ['79.53 E 17.98 N', 17.98, 79.53],
    ['33°52′S 151°12′E', -33.86667, 151.2],
    ['https://www.google.com/maps/@17.9833,79.5308,15z', 17.9833, 79.5308],
    ['https://www.google.com/maps/place/NIT/@17.98,79.53,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d17.9837!4d79.5307', 17.9837, 79.5307],
    ['https://maps.google.com/?q=17.9833,79.5308', 17.9833, 79.5308],
    ['https://www.google.com/maps/search/?api=1&query=17.9833%2C79.5308', 17.9833, 79.5308],
    ['https://www.openstreetmap.org/#map=16/17.9833/79.5308', 17.9833, 79.5308],
    ['geo:17.9833,79.5308?z=15', 17.9833, 79.5308],
  ])('reads %s', (input, lat, lng) => {
    const p = ok(input);
    expect(p.lat).toBeCloseTo(lat, 4);
    expect(p.lng).toBeCloseTo(lng, 4);
  });

  it.each(['', 'hello', '95, 10', '10, 200', '17.9 N 79.5 N', 'https://maps.app.goo.gl/abc123'])(
    'rejects %s with a helpful message',
    (input) => {
      const r = parseCoordinates(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    },
  );
});

describe('formatting', () => {
  it('formats distances like a dashboard', () => {
    expect(splitDistance(847)).toEqual({ value: '850', unit: 'm' });
    expect(formatDistance(999)).toBe('1.0 km');
    expect(formatDistance(2449)).toBe('2.4 km');
    expect(formatDistance(143_051)).toBe('143 km');
  });

  it('formats durations and speeds', () => {
    expect(formatDuration(30)).toBe('< 1 min');
    expect(formatDuration(1700)).toBe('28 min');
    expect(formatDuration(8000)).toBe('2 h 13 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatSpeed(16.67)).toBe('60 km/h');
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
