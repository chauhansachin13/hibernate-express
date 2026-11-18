import { searchPlaces, searchPlacesFallback, type Place, type SearchBias } from '../services/geocoding';
import { kindIcon } from './icons';

export interface SearchBoxOptions {
  input: HTMLInputElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  clear: HTMLButtonElement;
  getBias: () => SearchBias | null;
  onSelect: (place: Place) => void;
}

/** Accessible type-ahead place search (combobox + listbox pattern). */
export class SearchBox {
  private readonly o: SearchBoxOptions;
  private readonly cache = new Map<string, Place[]>();
  private results: Place[] = [];
  private active = -1;
  private timer = 0;
  private controller: AbortController | null = null;

  constructor(options: SearchBoxOptions) {
    this.o = options;
    const { input, clear, panel } = options;
    input.addEventListener('input', () => {
      clear.hidden = input.value.length === 0;
      this.schedule(false);
    });
    input.addEventListener('keydown', (e) => this.onKey(e));
    input.addEventListener('focus', () => {
      if (this.results.length) this.open();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      clear.hidden = true;
      this.results = [];
      this.controller?.abort();
      this.close();
      input.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.parentElement?.contains(e.target as Node)) this.close();
    });
  }

  private schedule(explicit: boolean): void {
    window.clearTimeout(this.timer);
    const q = this.o.input.value.trim();
    if (q.length < 3) {
      this.controller?.abort();
      this.results = [];
      this.close();
      return;
    }
    this.timer = window.setTimeout(() => void this.run(q, explicit), explicit ? 0 : 320);
  }

  private async run(q: string, explicit: boolean): Promise<void> {
    const key = q.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      this.render(cached, q);
      return;
    }
    this.controller?.abort();
    const ctrl = new AbortController();
    this.controller = ctrl;
    this.o.list.replaceChildren();
    this.o.status.textContent = 'Searching…';
    this.open();
    try {
      let places = await searchPlaces(q, this.o.getBias(), ctrl.signal);
      if (!places.length && explicit) places = await searchPlacesFallback(q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.cache.set(key, places);
      this.render(places, q);
    } catch {
      if (ctrl.signal.aborted) return;
      if (explicit) {
        try {
          const places = await searchPlacesFallback(q, ctrl.signal);
          if (ctrl.signal.aborted) return;
          this.cache.set(key, places);
          this.render(places, q);
          return;
        } catch {
          if (ctrl.signal.aborted) return;
        }
      }
      this.results = [];
      this.o.list.replaceChildren();
      this.o.status.textContent =
        "Search isn't reachable right now. Press Enter to retry, tap the map, or enter coordinates below.";
      this.open();
    }
  }

  private render(places: Place[], q: string): void {
    this.results = places;
    this.active = places.length ? 0 : -1;
    this.o.list.replaceChildren(
      ...places.map((place, i) => {
        const li = document.createElement('li');
        li.id = `hx-result-${i}`;
        li.className = 'search-option';
        li.setAttribute('role', 'option');
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.innerHTML = kindIcon(place.kind);
        const text = document.createElement('span');
        text.className = 'search-text';
        const name = document.createElement('strong');
        name.textContent = place.name;
        const detail = document.createElement('span');
        detail.textContent = place.detail;
        text.append(name, detail);
        li.append(kind, text);
        li.addEventListener('click', () => this.choose(i));
        li.addEventListener('pointermove', () => {
          if (this.active !== i) {
            this.active = i;
            this.highlight();
          }
        });
        return li;
      }),
    );
    this.o.status.textContent = places.length ? '' : `No places found for “${q}”. Try a nearby landmark or tap the map.`;
    this.open();
    this.highlight();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.results.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + this.results.length) % this.results.length;
      this.open();
      this.highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!this.o.panel.hidden && this.results[this.active]) this.choose(this.active);
      else this.schedule(true);
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  private choose(i: number): void {
    const place = this.results[i];
    if (!place) return;
    this.o.input.value = place.name;
    this.o.clear.hidden = false;
    this.close();
    this.o.input.blur();
    this.o.onSelect(place);
  }

  private highlight(): void {
    const items = [...this.o.list.children] as HTMLElement[];
    items.forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    if (this.active >= 0 && items[this.active]) {
      this.o.input.setAttribute('aria-activedescendant', items[this.active].id);
      items[this.active].scrollIntoView({ block: 'nearest' });
    } else {
      this.o.input.removeAttribute('aria-activedescendant');
    }
  }

  private open(): void {
    this.o.panel.hidden = false;
    this.o.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    this.o.panel.hidden = true;
    this.o.input.setAttribute('aria-expanded', 'false');
  }
}
