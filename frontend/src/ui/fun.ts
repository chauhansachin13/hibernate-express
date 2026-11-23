import { prefersReducedMotion } from './fx';

/**
 * The fun bits: speech bubbles, emoji bursts and a jelly squish on taps, with jokes for every
 * moment of a nap on an Indian bus. All transform/opacity animation (smooth on phones), and with
 * "reduce motion" the bubbles still appear but stand still and the bursts are left out.
 */
export const LINES = {
  sleepy: [
    '5 more minutes… 😴',
    "I'm not sleeping, I'm resting my eyes 👀",
    'Kumbhakaran is jealous of this nap 🐻',
    'Drool level: professional 🤤',
    'Conductor-approved nap ✅',
    'Pillow? Check. Stop? Pick one! 📍',
    'Tap the map, I dare you 🗺️',
  ],
  searching: [
    'Asking the auto-wala 🛺',
    'Checking with the chai stall ☕',
    'Waking up the map 🗺️',
    'Following the bus fumes 🚌💨',
    'Consulting Kumbhakaran 🐻',
    'Bribing the GPS with samosas 🥟',
  ],
  honk: ['Beep beep! 📯', 'Pom pom! 🚌', 'Horn OK please! 🎺', 'Side please! 📣'],
  milestone: {
    25: 'A quarter done — snore on 😴',
    50: 'Halfway there! Flip the pillow 🛏️',
    75: 'Three-quarters! Dream of your stop 🌙',
    90: 'Almost there — wipe the drool 🤤',
  } as Record<number, string>,
  awake: ['Good morning, sunshine ☀️', 'Rise and shine! 🌅', 'Kumbhakaran could never 💪', 'Eyes open, bag ready 🎒'],
  snooze: ['Fine… 2 more minutes 😴', 'Pillow re-fluffed 🛏️', 'Snooze pressed with style 💤', 'The bus waits for no one… except you 🚌'],
  arrival: ['You made it! 🎉', 'Stop reached, dignity intact 😎', 'Off you go, champ 🏆', 'Mission nap: complete 🫡'],
  start: ['Alarm set · sleep well 😴', "Sweet dreams 💤 we'll wake you", 'Pillow mode: ON 🛏️', 'Snore freely, we got this 🐻'],
  demo: ['Watch the magic ✨', 'Fake bus, real alarm 🚌', 'Practice nap starting 🎬'],
  train: ['Choo choo! 🚂', 'All aboard! 🚆'],
  bus: ['Pom pom! 🚌', 'Window seat secured 🪟'],
  gpsLost: ['Bus went into a cave 🦇 counting on…', 'GPS is napping too 😴 we keep counting'],
} as const;

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function stage(): HTMLElement {
  return document.getElementById('app') ?? document.body;
}

/** A speech bubble that pops out above `anchor`, floats up and fades away. */
export function bubble(anchor: Element, text: string, opts: { tone?: 'fun' | 'ok' | 'night'; ms?: number } = {}): void {
  if (!anchor.isConnected) return;
  const root = stage();
  const a = anchor.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  if (a.width === 0 && a.height === 0) return; // hidden
  const ms = opts.ms ?? 2400;
  const b = document.createElement('span');
  b.className = `fun-bubble tone-${opts.tone ?? 'fun'}`;
  b.setAttribute('aria-hidden', 'true');
  b.textContent = text;
  b.style.visibility = 'hidden';
  root.append(b);
  // Centred over the anchor but never past the app's edges; the pointer still aims at the anchor.
  const half = b.offsetWidth / 2;
  const want = a.left + a.width / 2 - r.left;
  const x = Math.min(Math.max(want, half + 10), r.width - half - 10);
  b.style.left = `${x}px`;
  b.style.top = `${Math.max(a.top - r.top, 70)}px`;
  b.style.setProperty('--arrow', `${Math.max(-half + 14, Math.min(half - 14, want - x))}px`);
  b.style.setProperty('--ms', `${ms}ms`);
  if (prefersReducedMotion()) b.classList.add('still');
  b.style.visibility = '';
  window.setTimeout(() => b.remove(), ms + 100);
}

/** Emoji bursting out of `anchor`: feathers when snoozing, stars when waking, drums for Kumbhakaran. */
export function burst(anchor: Element, emojis: readonly string[], count = 10, spread = 120): void {
  if (prefersReducedMotion() || !anchor.isConnected) return;
  const root = stage();
  const a = anchor.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const x = a.left + a.width / 2 - r.left;
  const y = a.top + a.height / 2 - r.top;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'fun-particle';
    p.setAttribute('aria-hidden', 'true');
    p.textContent = emojis[i % emojis.length];
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.7;
    const dist = spread * (0.55 + Math.random() * 0.6);
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty('--dx', `${(Math.cos(angle) * dist).toFixed(1)}px`);
    p.style.setProperty('--dy', `${(Math.sin(angle) * dist - 50).toFixed(1)}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 360 - 180)}deg`);
    p.style.setProperty('--d', `${Math.round(Math.random() * 140)}ms`);
    p.style.fontSize = `${18 + Math.round(Math.random() * 10)}px`;
    root.append(p);
    window.setTimeout(() => p.remove(), 1900);
  }
}

/** A jelly squish on every tap of a button, chip or result row. */
export function installJelly(root: HTMLElement): void {
  root.addEventListener(
    'pointerdown',
    (e) => {
      if (prefersReducedMotion()) return;
      const t = (e.target as Element | null)?.closest<HTMLElement>('.btn, .chip, .seg-btn, .search-option, .recent-chip, .dest-clear');
      if (!t || t.closest('.sheet.dragging')) return;
      t.classList.remove('jelly');
      void t.offsetWidth; // restart the animation
      t.classList.add('jelly');
    },
    { passive: true },
  );
  root.addEventListener('animationend', (e) => {
    const t = e.target as HTMLElement;
    if (e.animationName === 'jelly') t.classList.remove('jelly');
  });
}

/** The little sleeping bear for empty spots: breathes, blinks, and talks when tapped. */
export function sleepyBear(): HTMLElement {
  const wrap = document.createElement('button');
  wrap.type = 'button';
  wrap.className = 'fun-bear';
  wrap.setAttribute('aria-label', 'A sleepy bear. Tap it.');
  wrap.innerHTML =
    '<svg viewBox="0 0 64 64" aria-hidden="true">' +
    '<circle cx="19" cy="25" r="7.5" fill="#2dd4bf"/><circle cx="45" cy="25" r="7.5" fill="#2dd4bf"/>' +
    '<circle cx="19" cy="25" r="3.6" fill="#0f766e"/><circle cx="45" cy="25" r="3.6" fill="#0f766e"/>' +
    '<ellipse class="fun-bear-head" cx="32" cy="39" rx="18" ry="16.5" fill="#2dd4bf"/>' +
    '<path class="fun-bear-eyes" d="M22.5 36.5q3 3 6 0M35.5 36.5q3 3 6 0" fill="none" stroke="#063b36" stroke-width="2.4" stroke-linecap="round"/>' +
    '<g class="fun-bear-open"><circle cx="25.5" cy="36" r="2.6" fill="#063b36"/><circle cx="38.5" cy="36" r="2.6" fill="#063b36"/></g>' +
    '<ellipse cx="32" cy="45" rx="7.5" ry="5.8" fill="#ccfbf1"/><ellipse cx="32" cy="42.6" rx="2.9" ry="2.1" fill="#063b36"/>' +
    '<ellipse class="fun-bear-mouth" cx="32" cy="48.6" rx="2.2" ry="1.4" fill="#063b36"/>' +
    '</svg><span class="fun-bear-z">z</span><span class="fun-bear-z z2">z</span><span class="fun-bear-z z3">Z</span>';
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.remove('poked');
    void wrap.offsetWidth;
    wrap.classList.add('poked');
    bubble(wrap, pick(LINES.sleepy));
  });
  return wrap;
}
