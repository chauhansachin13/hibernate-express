export type Snap = 'peek' | 'half' | 'full';

export interface SheetOptions {
  /** Visible height in px of the collapsed sheet (depends on what the sheet shows). */
  peek: () => number;
  onChange?: (snap: Snap) => void;
}

interface Drag {
  pointerId: number;
  startY: number;
  startOffset: number;
  /** True once the pointer has moved far enough to be a drag, not a tap. */
  active: boolean;
  fromHandle: boolean;
  samples: { y: number; t: number }[];
}

const DRAG_SLOP = 8;

/**
 * A draggable bottom sheet like native map apps: three snap points, flick velocity, rubber
 * banding and a springy settle. Drag it by the handle, or by its content while it isn't fully
 * open (when it is, the content scrolls instead). Exposes how much of it is visible as
 * --sheet-visible on the app so floating buttons and map padding follow it.
 */
export class BottomSheet {
  private readonly sheet: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly body: HTMLElement;
  private readonly app: HTMLElement;
  private readonly opts: SheetOptions;
  private current: Snap = 'peek';
  private offset = 0;
  private drag: Drag | null = null;
  private suppressClick = false;
  private wheelLock = 0;

  constructor(sheet: HTMLElement, handle: HTMLElement, body: HTMLElement, app: HTMLElement, opts: SheetOptions) {
    this.sheet = sheet;
    this.handle = handle;
    this.body = body;
    this.app = app;
    this.opts = opts;
    sheet.addEventListener('pointerdown', (e) => this.down(e));
    sheet.addEventListener('pointermove', (e) => this.move(e));
    sheet.addEventListener('pointerup', (e) => this.up(e));
    sheet.addEventListener('pointercancel', (e) => this.up(e, true));
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
    window.addEventListener('resize', () => this.setSnap(this.current, false));
  }

  get snap(): Snap {
    return this.current;
  }

  /** Pixels of the sheet currently on screen. */
  get visibleHeight(): number {
    return Math.max(0, this.sheet.offsetHeight - this.offset);
  }

  /** Visible height in px for each snap point. */
  private visible(): Record<Snap, number> {
    const h = this.app.clientHeight;
    const max = this.sheet.offsetHeight;
    const peek = Math.min(max, Math.max(120, Math.round(this.opts.peek())));
    const half = Math.min(max, Math.max(peek + 60, Math.round(h * 0.58)));
    return { peek, half, full: max };
  }

  setSnap(snap: Snap, animate = true): void {
    const was = this.current;
    this.current = snap;
    const v = this.visible();
    this.apply(this.sheet.offsetHeight - v[snap], animate);
    this.sheet.dataset.snap = snap;
    this.app.dataset.snap = snap;
    this.handle.setAttribute('aria-expanded', String(snap !== 'peek'));
    if (snap !== 'full' && this.body.scrollTop > 0) this.body.scrollTo({ top: 0, behavior: animate ? 'smooth' : 'auto' });
    if (was !== snap || !animate) this.opts.onChange?.(snap);
  }

  /** Re-measures the snap points (e.g. after the content changed) without changing the snap. */
  refresh(animate = true): void {
    this.setSnap(this.current, animate);
  }

  private cycle(): void {
    this.setSnap(this.current === 'full' ? 'half' : this.current === 'half' ? 'full' : 'half');
  }

  private apply(offset: number, animate: boolean): void {
    this.offset = offset;
    this.sheet.classList.toggle('settling', animate);
    this.app.classList.toggle('sheet-settling', animate);
    this.sheet.style.transform = `translate3d(0, ${Math.round(this.offset)}px, 0)`;
    this.app.style.setProperty('--sheet-visible', `${Math.round(this.visibleHeight)}px`);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const fromHandle = this.handle.contains(e.target as Node);
    // When fully open the content scrolls natively; only the handle drags the sheet.
    if (!fromHandle && this.current === 'full') return;
    if (!fromHandle && (e.target as HTMLElement).closest('input, select, textarea, summary')) return;
    this.drag = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startOffset: this.offset,
      active: false,
      fromHandle,
      samples: [{ y: e.clientY, t: performance.now() }],
    };
    if (fromHandle) this.handle.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      d.active = true;
      this.sheet.classList.add('dragging');
      this.app.classList.add('sheet-dragging');
      if (!d.fromHandle) this.sheet.setPointerCapture(e.pointerId);
    }
    const v = this.visible();
    const h = this.sheet.offsetHeight;
    const min = h - v.full;
    const max = h - v.peek;
    let next = d.startOffset + dy;
    // Rubber-band past the ends.
    if (next < min) next = min - (min - next) * 0.22;
    if (next > max) next = max + (next - max) * 0.35;
    this.apply(next, false);
    d.samples.push({ y: e.clientY, t: performance.now() });
    if (d.samples.length > 6) d.samples.shift();
  }

  private up(e: PointerEvent, cancelled = false): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    this.sheet.classList.remove('dragging');
    this.app.classList.remove('sheet-dragging');
    for (const el of [this.handle, this.sheet]) if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!d.active) {
      // A tap on the handle opens or closes the sheet; taps on the content pass through.
      if (d.fromHandle && !cancelled) this.cycle();
      return;
    }
    this.suppressClick = true;
    window.setTimeout(() => (this.suppressClick = false), 350);
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px per ms
    const projected = this.offset + velocity * 240;
    const v = this.visible();
    const h = this.sheet.offsetHeight;
    let best: Snap = this.current;
    let bestDist = Infinity;
    for (const s of ['full', 'half', 'peek'] as const) {
      const dist = Math.abs(h - v[s] - projected);
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    this.setSnap(best);
  }

  /** Mouse wheel / trackpad: scroll up to open, down to close (content scrolls when full). */
  private wheel(e: WheelEvent): void {
    if (Math.abs(e.deltaY) < 4) return;
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
