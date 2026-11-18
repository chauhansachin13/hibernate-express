/** Small animation helpers. Everything respects "reduce motion". */

export const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const tweens = new WeakMap<HTMLElement, number>();
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Animates the number shown in {@code el} from its last value to {@code to}. */
export function tweenNumber(el: HTMLElement, to: number, format: (v: number) => string, ms = 700): void {
  const from = Number(el.dataset.value);
  el.dataset.value = String(to);
  const running = tweens.get(el);
  if (running) cancelAnimationFrame(running);
  if (!Number.isFinite(from) || !Number.isFinite(to) || prefersReducedMotion() || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = format(from + (to - from) * easeOutCubic(t));
    if (t < 1) tweens.set(el, requestAnimationFrame(step));
    else tweens.delete(el);
  };
  tweens.set(el, requestAnimationFrame(step));
}

/** A light tap on Android phones (iOS browsers ignore vibration). */
export function haptic(pattern: number | number[] = 8): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    // Not allowed right now.
  }
}

/** Material-style ink ripple plus a haptic tick on every button, chip and tile. */
export function installRipples(root: HTMLElement): void {
  root.addEventListener('pointerdown', (e) => {
    const host = (e.target as HTMLElement).closest<HTMLElement>('.btn, .chip, .seg-btn, .fab, .tile-btn, .recent-chip, [data-ripple]');
    if (!host || host.matches(':disabled')) return;
    haptic(6);
    if (prefersReducedMotion()) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ink = document.createElement('span');
    ink.className = 'ink';
    ink.style.width = ink.style.height = `${size}px`;
    ink.style.left = `${e.clientX - rect.left - size / 2}px`;
    ink.style.top = `${e.clientY - rect.top - size / 2}px`;
    host.append(ink);
    ink.addEventListener('animationend', () => ink.remove(), { once: true });
  });
}

/** Gives children an index so CSS can stagger their entrance animation. */
export function stagger(container: Element): void {
  [...container.children].forEach((child, i) => (child as HTMLElement).style.setProperty('--i', String(i)));
}

/** Types text out letter by letter. */
export async function typewriter(el: HTMLElement, text: string, cps = 30): Promise<void> {
  if (prefersReducedMotion()) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  el.classList.add('typing');
  for (const ch of text) {
    el.textContent += ch;
    await new Promise((r) => setTimeout(r, 1000 / cps));
  }
  el.classList.remove('typing');
}

/** Adds .in to .reveal elements as they scroll into view. */
export function revealOnScroll(root: HTMLElement): void {
  const items = root.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    },
    { root, threshold: 0.15 },
  );
  items.forEach((el) => io.observe(el));
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vr: number;
  color: string;
  shape: 0 | 1;
}

/** A celebratory confetti burst on a full-screen canvas. */
export function confetti(canvas: HTMLCanvasElement, ms = 2800): void {
  if (prefersReducedMotion()) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#2dd4bf', '#5eead4', '#fde68a', '#fbbf24', '#f472b6', '#e9eff8', '#38bdf8'];
  const parts: Particle[] = Array.from({ length: 160 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const speed = 7 + Math.random() * 9;
    return {
      x: w / 2 + (Math.random() - 0.5) * 60,
      y: h * 0.38,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() < 0.5 ? 0 : 1,
    };
  });
  canvas.hidden = false;
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    const fade = t > ms - 600 ? Math.max(0, (ms - t) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.28;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 0) ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (t < ms) requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, w, h);
      canvas.hidden = true;
    }
  };
  requestAnimationFrame(frame);
}
