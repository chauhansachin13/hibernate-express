import type { LatLng } from './geo';

export type CoordinateParse = { ok: true; value: LatLng } | { ok: false; error: string };

const NUM = '[-+]?\\d+(?:\\.\\d+)?';
const EXAMPLE = 'Try something like 17.9833, 79.5308';

function fail(error: string): CoordinateParse {
  return { ok: false, error };
}

function build(lat: number, lng: number): CoordinateParse {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(`Couldn't read those numbers. ${EXAMPLE}`);
  if (Math.abs(lat) > 90) return fail('Latitude must be between -90 and 90.');
  if (Math.abs(lng) > 180) return fail('Longitude must be between -180 and 180.');
  return { ok: true, value: { lat, lng } };
}

/**
 * Reads a destination from whatever people paste: plain decimal pairs,
 * degrees-minutes-seconds, hemisphere letters, Google Maps / OpenStreetMap
 * links, or geo: URIs.
 */
export function parseCoordinates(raw: string): CoordinateParse {
  const input = raw.trim();
  if (!input) return fail(`Enter coordinates. ${EXAMPLE}`);
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(input)) {
    return fail(
      "Short Google Maps links can't be opened here. Open the link, long-press the pin and copy the coordinates instead.",
    );
  }

  let text = input;
  try {
    text = decodeURIComponent(input);
  } catch {
    // Not URI-encoded; use as is.
  }

  // Google Maps place links carry the pin itself as !3d<lat>!4d<lng>.
  const pin = text.match(new RegExp(`!3d(${NUM})!4d(${NUM})`));
  if (pin) return build(+pin[1], +pin[2]);

  const query = text.match(
    new RegExp(`[?&](?:q|query|ll|destination|daddr|center|sll)=(?:loc:)?\\s*(${NUM})\\s*,\\s*(${NUM})`, 'i'),
  );
  if (query) return build(+query[1], +query[2]);

  const atCentre = text.match(new RegExp(`@(${NUM}),(${NUM})`));
  if (atCentre) return build(+atCentre[1], +atCentre[2]);

  const osmHash = text.match(new RegExp(`#map=\\d+(?:\\.\\d+)?/(${NUM})/(${NUM})`));
  if (osmHash) return build(+osmHash[1], +osmHash[2]);

  const osmMarker = text.match(new RegExp(`mlat=(${NUM}).*?mlon=(${NUM})`));
  if (osmMarker) return build(+osmMarker[1], +osmMarker[2]);

  const geo = text.match(new RegExp(`^geo:(${NUM}),(${NUM})`, 'i'));
  if (geo) return build(+geo[1], +geo[2]);

  if (/^https?:\/\//i.test(text)) return fail("Couldn't find coordinates in that link.");
  return parseText(text);
}

interface Component {
  value: number;
  axis: 'lat' | 'lng' | null;
}

function parseText(text: string): CoordinateParse {
  const s = text
    .toUpperCase()
    .replace(/[’′‘`´]/g, "'")
    .replace(/[”″“]/g, '"')
    .replace(/''/g, '"')
    .replace(/[º˚]/g, '°')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\d/.test(s)) return fail(`Couldn't find any numbers. ${EXAMPLE}`);

  let parts: string[] | null = null;
  const letters = [...s.matchAll(/[NSEW]/g)];
  if (letters.length === 2) {
    const first = letters[0].index ?? 0;
    const second = letters[1].index ?? 0;
    // "17.98N 79.53E" has letters after the numbers, "N 17.98 E 79.53" before.
    const trailing = /\d/.test(s.slice(0, first));
    const cut = trailing ? first + 1 : second;
    parts = [s.slice(0, cut), s.slice(cut)];
  } else if (letters.length === 0) {
    if (s.includes(',')) parts = s.split(',');
    else if (s.includes(';')) parts = s.split(';');
    else {
      const numbers = s.match(/[-+]?\d+(?:\.\d+)?/g);
      if (numbers && numbers.length === 2) parts = numbers;
    }
  } else {
    return fail('Use one N/S letter and one E/W letter, e.g. 17.98 N, 79.53 E.');
  }

  if (!parts || parts.length !== 2) return fail(`Couldn't read that. ${EXAMPLE}`);
  const a = parseComponent(parts[0]);
  const b = parseComponent(parts[1]);
  if (!a || !b) return fail(`Couldn't read that. ${EXAMPLE}`);
  if (a.axis !== null && a.axis === b.axis) return fail('Both values point the same way. Use one N/S and one E/W.');

  const swap = a.axis === 'lng' || b.axis === 'lat';
  return swap ? build(b.value, a.value) : build(a.value, b.value);
}

function parseComponent(part: string): Component | null {
  const letter = part.match(/[NSEW]/)?.[0] ?? null;
  const numbers = part.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length > 3) return null;
  const [d, m = '0', sec = '0'] = numbers;
  const degrees = parseFloat(d);
  const minutes = parseFloat(m);
  const seconds = parseFloat(sec);
  if (minutes >= 60 || seconds >= 60) return null;
  if (numbers.length > 1 && !Number.isInteger(degrees)) return null;
  let value = degrees + minutes / 60 + seconds / 3600;
  if (/(^|[^\d.])-\s*\d/.test(part)) value = -value;
  if (letter === 'S' || letter === 'W') value = -Math.abs(value);
  const axis = letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lng' : null;
  return { value, axis };
}
