export type Snap = 'peek' | 'half' | 'full';

export interface SheetOptions {
  /** Visible height in px of the collapsed sheet (depends on what the sheet shows). */
  peek: () => number;
  onChange?: (snap: Snap) => void;
}

/** Movement (px) before a touch counts as a drag rather than a tap. */
const SLOP = 6;
/** Release speed (px/ms) above which a flick moves on to the next snap point. */
const FLING = 0.4;
/** Spring stiffness (rad/s), critically damped: settles in about 0.3 s with no bounce. */
const OMEGA = 24;
/** Pointer history (ms) used to measure the release speed. */
const VELOCITY_WINDOW = 90;
/** How far (px) the sheet can be pulled past its ends, approached ever more slowly. */
const STRETCH_TOP = 36;
const STRETCH_BOTTOM = 110;

interface Gesture {
  kind: 'touch' | 'pointer';
  id: number;
  startX: number;
  startY: number;
  startOffset: number;
  fromHandle: boolean;
  /** Started on the content while it scrolls (sheet fully open). */
  fromScroller: boolean;
  state: 'pending' | 'drag' | 'ignore';
  samples: { y: number; t: number }[];
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** iOS-style rubber band: follows the finger at first, then ever more slowly, never past `limit`. */
function rubber(over: number, limit: number): number {
  return limit * (1 - 1 / (over / limit + 1));
}

/**
 * A bottom sheet that moves like the one in Google Maps: it follows the finger exactly, a flick
 * moves it on to the next snap point, and it settles with a critically damped spring that starts
 * at the speed of the release and can be caught mid-flight. Drag it by the handle or by its
 * content; when it is fully open the content scrolls, and pulling down at the top of the content
 * hands the gesture back to the sheet. Floating buttons follow it in the same frame.
 */
export class BottomSheet {
  private readonly sheet: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly body: HTMLElement;
  private readonly app: HTMLElement;
  private readonly opts: SheetOptions;
  private current: Snap = 'peek';
  private hidden = false;
  /** How far (px) the sheet is pushed down from fully open; what is on screen right now. */
  private offset = 0;
  private height = 0;
  private gesture: Gesture | null = null;
  private animation = 0;
  private renderQueued = false;
  private suppressClick = false;
  private wheelLock = 0;
  private followers: HTMLElement[] = [];

  constructor(sheet: HTMLElement, handle: HTMLElement, body: HTMLElement, app: HTMLElement, opts: SheetOptions) {
    this.sheet = sheet;
    this.handle = handle;
    this.body = body;
    this.app = app;
    this.opts = opts;
    this.measure();
    this.offset = this.height;

    // Touch: its own listeners, so a pull-down at the top of scrolled content can take over.
    sheet.addEventListener('touchstart', (e) => this.touchStart(e), { passive: true });
    sheet.addEventListener('touchmove', (e) => this.touchMove(e), { passive: false });
    sheet.addEventListener('touchend', (e) => this.touchEnd(e, false));
    sheet.addEventListener('touchcancel', (e) => this.touchEnd(e, true));
    // Mouse and pen. Moves and releases are heard on the whole window: the pointer is only
    // captured once a drag starts, because a captured press turns its click into a click on the
    // sheet, and then buttons in the sheet never get clicked.
    sheet.addEventListener('pointerdown', (e) => this.pointerDown(e));
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e, false));
    window.addEventListener('pointercancel', (e) => this.pointerUp(e, true));
    // A drag that started on a button must not also press it.
    sheet.addEventListener(
      'click',
      (e) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    sheet.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') this.setSnap(this.current === 'peek' ? 'half' : 'full');
      else if (e.key === 'ArrowDown') this.setSnap(this.current === 'full' ? 'half' : 'peek');
      else if (e.key === 'Enter' || e.key === ' ') this.cycle();
      else return;
      e.preventDefault();
    });
    // The window, or the sheet itself (it is taller during a ride), changed size: re-place it.
    const resized = new ResizeObserver(() => {
      const before = this.height;
      this.measure();
      if (this.height !== before && !this.gesture) this.setSnap(this.current, false);
    });
    resized.observe(app);
    resized.observe(sheet);
  }

  get snap(): Snap {
    return this.current;
  }

  /** Pixels of the sheet currently on screen. */
  get visibleHeight(): number {
    return Math.max(0, this.height - this.offset);
  }

  setSnap(snap: Snap, animate = true): void {
    const was = this.current;
    this.current = snap;
    if (!this.gesture) this.measure();
    this.sheet.dataset.snap = snap;
    this.app.dataset.snap = snap;
    this.handle.setAttribute('aria-expanded', String(snap !== 'peek'));
    if (snap !== 'full' && this.body.scrollTop > 0) this.body.scrollTo({ top: 0, behavior: animate ? 'smooth' : 'auto' });
    if (!this.gesture) this.moveTo(this.restingOffset(), 0, animate);
    if (was !== snap || !animate) this.opts.onChange?.(snap);
  }

  /** Re-measures the snap points (e.g. after the content changed) without changing the snap. */
  refresh(animate = true): void {
    this.measure();
    this.setSnap(this.current, animate);
  }

  /** Slides the whole sheet off screen (while searching) and back. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.sheet.classList.toggle('is-hidden', hidden);
    if (this.gesture) this.endGesture();
    this.measure();
    this.moveTo(this.restingOffset(), 0, true);
  }

  private measure(): void {
    this.height = this.sheet.offsetHeight;
    // The map adds its corner controls after the sheet exists, so look them up each time.
    this.followers = Array.from(this.app.querySelectorAll<HTMLElement>('.map-fabs, .leaflet-bottom'));
  }

  /** Visible height in px for each snap point. */
  private visible(): Record<Snap, number> {
    const h = this.app.clientHeight;
    const max = this.height;
    const peek = Math.min(max, Math.max(120, Math.round(this.opts.peek())));
    const half = Math.min(max, Math.max(peek + 60, Math.round(h * 0.58)));
    return { peek, half, full: max };
  }

  private offsetFor(snap: Snap): number {
    return this.height - this.visible()[snap];
  }

  private restingOffset(): number {
    return this.hidden ? this.height + 24 : this.offsetFor(this.current);
  }

  private cycle(): void {
    this.setSnap(this.current === 'full' ? 'half' : this.current === 'half' ? 'full' : 'half');
  }

  // ------------------------------------------------------------------ motion

  /** Draws the current offset; called at most once per frame. */
  private render = (): void => {
    this.renderQueued = false;
    const y = this.offset;
    this.sheet.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    const visible = `${Math.max(0, this.height - y).toFixed(2)}px`;
    for (const f of this.followers) f.style.setProperty('--sheet-visible', visible);
  };

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(this.render);
  }

  private stopAnimation(): void {
    if (this.animation) cancelAnimationFrame(this.animation);
    this.animation = 0;
    this.sheet.classList.remove('settling');
  }

  /**
   * Springs to `target` starting at `velocity` (px/ms): x(t) = (x0 + (v0 + ωx0)t)·e^(−ωt), the
   * critically damped solution, so it never bounces and stays smooth when the finger lets go.
   */
  private moveTo(target: number, velocity: number, animate: boolean): void {
    this.stopAnimation();
    if (this.followers.length < 2) this.measure();
    const x0 = this.offset - target;
    if (!animate || reducedMotion() || (Math.abs(x0) < 0.5 && Math.abs(velocity) < 0.02)) {
      this.offset = target;
      this.render();
      return;
    }
    // A flick towards the target faster than ωx0 would overshoot once; cap it there instead.
    let v0 = velocity * 1000;
    if (v0 * x0 < 0 && Math.abs(v0) > OMEGA * Math.abs(x0)) v0 = -Math.sign(x0) * OMEGA * Math.abs(x0);
    const start = performance.now();
    this.sheet.classList.add('settling');
    const step = (now: number) => {
      const t = Math.max(0, now - start) / 1000;
      const decay = Math.exp(-OMEGA * t);
      const x = (x0 + (v0 + OMEGA * x0) * t) * decay;
      const v = (v0 - OMEGA * (v0 + OMEGA * x0) * t) * decay;
      if (Math.abs(x) < 0.3 && Math.abs(v) < 12) {
        this.animation = 0;
        this.sheet.classList.remove('settling');
        this.offset = target;
        this.render();
        return;
      }
      this.offset = target + x;
      this.render();
      this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- gestures

  private begin(kind: Gesture['kind'], id: number, x: number, y: number, target: EventTarget | null): void {
    const el = target instanceof Element ? target : null;
    if (this.hidden || !el) return;
    if (el.closest('input, select, textarea, [contenteditable="true"]')) return;
    const fromHandle = this.handle.contains(el);
    const fromScroller = !fromHandle && this.current === 'full' && this.body.contains(el);
    // Catch the sheet where it is if it is still settling.
    if (this.animation) {
      this.stopAnimation();
    }
    this.measure();
    this.gesture = {
      kind,
      id,
      startX: x,
      startY: y,
      startOffset: this.offset,
      fromHandle,
      fromScroller,
      state: 'pending',
      samples: [{ y, t: performance.now() }],
    };
  }

  /**
   * Returns true while the gesture moves the sheet (so the caller can block scrolling). `at` is
   * the event's own timestamp: when the finger moved, even if the page was busy at the time.
   */
  private track(x: number, y: number, at: number): boolean {
    const g = this.gesture;
    if (!g || g.state === 'ignore') return false;
    if (g.state === 'pending') {
      const dx = x - g.startX;
      const dy = y - g.startY;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return false;
      if (Math.abs(dx) > Math.abs(dy)) {
        g.state = 'ignore'; // a sideways swipe, e.g. across a row of chips
        return false;
      }
      if (g.fromScroller && !(this.body.scrollTop <= 0 && dy > 0)) {
        g.state = 'ignore'; // the content scrolls; only a pull-down at its top moves the sheet
        return false;
      }
      g.state = 'drag';
      // Mouse and pen: keep the drag even if the pointer leaves the sheet.
      if (g.kind === 'pointer') this.capture(g.id);
      // Start from here, so the sheet doesn't jump by the slop distance.
      g.startY = y;
      g.startOffset = this.offset;
      g.samples = [{ y, t: at }];
      this.sheet.classList.add('dragging');
      this.app.classList.add('sheet-dragging');
    }
    const min = this.offsetFor('full');
    const max = this.offsetFor('peek');
    let next = g.startOffset + (y - g.startY);
    if (next < min) next = min - rubber(min - next, STRETCH_TOP);
    if (next > max) next = max + rubber(next - max, STRETCH_BOTTOM);
    this.offset = next;
    this.queueRender();
    g.samples.push({ y, t: at });
    while (g.samples.length > 2 && at - g.samples[0].t > VELOCITY_WINDOW) g.samples.shift();
    return true;
  }

  private finish(cancelled: boolean, at: number): void {
    const g = this.gesture;
    if (!g) return;
    this.endGesture();
    if (g.state === 'pending') {
      // A tap on the handle opens or closes the sheet; taps on the content pass through.
      if (g.fromHandle && !cancelled) this.cycle();
      else this.moveTo(this.restingOffset(), 0, true);
      return;
    }
    if (g.state !== 'drag') return;
    this.suppressClick = true;
    window.setTimeout(() => (this.suppressClick = false), 350);
    const first = g.samples[0];
    const last = g.samples[g.samples.length - 1];
    // Px per ms; a finger that stopped before letting go has no speed.
    const velocity = at - last.t > 70 || last.t <= first.t ? 0 : (last.y - first.y) / (last.t - first.t);
    const snap = this.chooseSnap(velocity);
    const was = this.current;
    this.current = snap;
    this.sheet.dataset.snap = snap;
    this.app.dataset.snap = snap;
    this.handle.setAttribute('aria-expanded', String(snap !== 'peek'));
    if (snap !== 'full' && this.body.scrollTop > 0) this.body.scrollTo({ top: 0, behavior: 'smooth' });
    this.moveTo(this.offsetFor(snap), velocity, true);
    if (was !== snap) this.opts.onChange?.(snap);
  }

  /** A flick goes on to the next snap point in its direction; a slow release to the nearest. */
  private chooseSnap(velocity: number): Snap {
    const points = (['full', 'half', 'peek'] as const).map((snap) => ({ snap, y: this.offsetFor(snap) }));
    const y = this.offset;
    if (Math.abs(velocity) > FLING) {
      const ahead =
        velocity < 0
          ? points.filter((p) => p.y < y - 1).sort((a, b) => b.y - a.y)[0]
          : points.filter((p) => p.y > y + 1).sort((a, b) => a.y - b.y)[0];
      if (ahead) return ahead.snap;
    }
    const projected = y + velocity * 120;
    return points.reduce((best, p) => (Math.abs(p.y - projected) < Math.abs(best.y - projected) ? p : best)).snap;
  }

  private endGesture(): void {
    this.gesture = null;
    this.sheet.classList.remove('dragging');
    this.app.classList.remove('sheet-dragging');
  }

  // --- touch

  private touchStart(e: TouchEvent): void {
    if (this.gesture || e.touches.length > 1) return;
    const t = e.changedTouches[0];
    this.begin('touch', t.identifier, t.clientX, t.clientY, e.target);
  }

  private findTouch(list: TouchList): Touch | null {
    const g = this.gesture;
    if (!g || g.kind !== 'touch') return null;
    for (let i = 0; i < list.length; i++) if (list[i].identifier === g.id) return list[i];
    return null;
  }

  private touchMove(e: TouchEvent): void {
    const t = this.findTouch(e.changedTouches);
    if (!t) return;
    if (this.track(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault();
  }

  private touchEnd(e: TouchEvent, cancelled: boolean): void {
    if (this.findTouch(e.changedTouches)) this.finish(cancelled, e.timeStamp);
  }

  // --- mouse and pen

  private pointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch' || e.button !== 0 || this.gesture) return;
    this.begin('pointer', e.pointerId, e.clientX, e.clientY, e.target);
  }

  private capture(pointerId: number): void {
    try {
      this.sheet.setPointerCapture(pointerId);
    } catch {
      // The pointer is already up; the window still hears its release.
    }
  }

  private pointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== 'pointer' || e.pointerId !== g.id) return;
    this.track(e.clientX, e.clientY, e.timeStamp);
  }

  private pointerUp(e: PointerEvent, cancelled: boolean): void {
    const g = this.gesture;
    if (!g || g.kind !== 'pointer' || e.pointerId !== g.id) return;
    if (this.sheet.hasPointerCapture(e.pointerId)) this.sheet.releasePointerCapture(e.pointerId);
    this.finish(cancelled, e.timeStamp);
  }

  /** Mouse wheel / trackpad: scroll up to open, down to close (content scrolls when full). */
  private wheel(e: WheelEvent): void {
    if (Math.abs(e.deltaY) < 4 || this.hidden) return;
    const opening = e.deltaY > 0;
    if (this.current === 'full' && (opening || this.body.scrollTop > 0)) return;
    e.preventDefault();
    const now = performance.now();
    if (now < this.wheelLock) return;
    this.wheelLock = now + 450;
    if (opening) this.setSnap(this.current === 'peek' ? 'half' : 'full');
    else this.setSnap(this.current === 'full' ? 'half' : 'peek');
  }
}
