import { api, ApiError, wantsPhoton, type Place, type SearchResult } from '../api';
import { formatDistance } from '../core/format';
import { haversine, type LatLng } from '../core/geo';
import { stagger } from './fx';
import { icon, kindIcon } from './icons';

export interface SearchBoxOptions {
  input: HTMLInputElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  clear: HTMLButtonElement;
  getBias: () => { lat: number; lng: number; zoom: number } | null;
  /** Your position, for "2.3 km" next to each result. */
  getUser?: () => LatLng | null;
  /** Shown when the box is focused but empty, like a map app's history. */
  getRecents?: () => Place[];
  onSelect: (place: Place) => void;
  onOpenChange?: (open: boolean) => void;
}

type Row = { type: 'place'; place: Place } | { type: 'more' } | { type: 'google' } | { type: 'paste' };

const MIN_CHARS = 2;
const WORD = /[\p{L}\p{N}]/u;
const LINK = /https?:\/\/|maps\.app\.goo\.gl|goo\.gl\/maps/i;

/**
 * One search box for everything, through the Java backend: place names, addresses, villages,
 * "bus stand near me", coordinates, plus codes and Google Maps links. Combobox + listbox pattern.
 */
export class SearchBox {
  private readonly o: SearchBoxOptions;
  private readonly cache = new Map<string, SearchResult>();
  private rows: Row[] = [];
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
      if (input.value.trim().length < MIN_CHARS) this.showRecents();
      else if (this.rows.length) this.open();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      clear.hidden = true;
      this.controller?.abort();
      input.focus();
      this.showRecents();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.parentElement?.contains(e.target as Node)) this.close();
    });
  }

  setValue(text: string): void {
    this.o.input.value = text;
    this.o.clear.hidden = text.length === 0;
  }

  /** Searches for text from elsewhere (a place shared from another app), thoroughly. */
  searchFor(text: string): void {
    const q = text.trim();
    if (q.length < MIN_CHARS) return;
    this.setValue(q);
    void this.run(q, true);
  }

  private schedule(explicit: boolean): void {
    window.clearTimeout(this.timer);
    const q = this.o.input.value.trim();
    if (q.length < MIN_CHARS) {
      this.controller?.abort();
      this.showRecents();
      return;
    }
    this.timer = window.setTimeout(() => void this.run(q, explicit), explicit ? 0 : 250);
  }

  private async run(q: string, explicit: boolean, retried = false): Promise<void> {
    const key = `${explicit ? '!' : ''}${q.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.render(cached, q, explicit);
      return;
    }
    this.controller?.abort();
    const ctrl = new AbortController();
    this.controller = ctrl;
    const moreRow = this.o.list.querySelector('.search-more');
    if (explicit && moreRow) moreRow.classList.add('is-loading');
    else this.showLoading();
    try {
      const result = await api.search(q, this.o.getBias(), explicit, ctrl.signal, (first) => {
        if (!ctrl.signal.aborted) this.render(first, q, explicit, true);
      });
      if (ctrl.signal.aborted) return;
      this.cache.set(key, result);
      this.render(result, q, explicit);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // Free hosting sleeps when idle: if the server is still waking up, wait for it and retry once.
      if (!retried && err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
        this.o.status.textContent = 'Waking up the server — up to a minute after a quiet spell…';
        this.open();
        const awake = await api.wake();
        if (ctrl.signal.aborted) return;
        if (awake) {
          void this.run(q, explicit, true);
          return;
        }
      }
      this.rows = [];
      this.o.list.replaceChildren();
      this.o.status.textContent = "Search isn't reachable right now. Press Enter to retry, or tap the map.";
      this.open();
    }
  }

  private showLoading(): void {
    this.o.status.textContent = '';
    this.o.list.replaceChildren(
      ...[0, 1, 2, 3].map(() => {
        const li = document.createElement('li');
        li.className = 'search-skeleton';
        li.setAttribute('role', 'presentation');
        li.innerHTML = '<span class="sk-icon"></span><span class="sk-lines"><span></span><span></span></span>';
        return li;
      }),
    );
    this.open();
  }

  private showRecents(): void {
    const recents = this.o.getRecents?.() ?? [];
    if (recents.length === 0 || document.activeElement !== this.o.input) {
      this.rows = [];
      this.close();
      return;
    }
    this.rows = recents.map((place) => ({ type: 'place', place }));
    this.active = -1;
    this.o.status.textContent = '';
    const head = document.createElement('li');
    head.className = 'search-head';
    head.setAttribute('role', 'presentation');
    head.textContent = 'Recent stops';
    this.o.list.replaceChildren(head, ...recents.map((place, i) => this.option(place, '', i, 'i-history')));
    stagger(this.o.list);
    this.open();
    this.highlightActive();
  }

  private render(result: SearchResult, q: string, explicit: boolean, partial = false): void {
    const places = result.places;
    // A pasted or shared map link that names one spot: that's the stop, no need to pick it.
    if (!partial && LINK.test(q) && places.length === 1) {
      this.rows = [{ type: 'place', place: places[0] }];
      this.choose(0);
      return;
    }
    this.rows = places.map((place) => ({ type: 'place', place }));
    const items: HTMLElement[] = places.map((place, i) => this.option(place, q, i));
    if (result.more) {
      this.rows.push({ type: 'more' });
      items.push(this.moreRow(this.rows.length - 1, q));
    }
    if (wantsPhoton(q)) {
      // Every place Google Maps knows is one share away.
      this.rows.push({ type: 'google' });
      items.push(this.actionRow(this.rows.length - 1, 'i-share', 'Not here? Find it on Google Maps', 'Then Share → Copy link, and paste it here'));
      this.rows.push({ type: 'paste' });
      items.push(this.actionRow(this.rows.length - 1, 'i-link', 'Paste a Google Maps link', 'Any place, shop or house Google Maps knows'));
    }
    this.active = places.length ? 0 : -1;
    this.o.list.replaceChildren(...items);
    if (!partial) stagger(this.o.list);
    let status = '';
    if (!places.length) {
      status =
        result.message ??
        (explicit
          ? `No places found for “${q}” in the open map data. Find it on Google Maps below, or tap the map.`
          : `No quick matches for “${q}” — search more places, or find it on Google Maps below.`);
    }
    this.o.status.textContent = status;
    this.open();
    this.highlightActive();
  }

  private option(place: Place, q: string, index: number, iconId?: string): HTMLLIElement {
    const li = document.createElement('li');
    li.id = `hx-result-${index}`;
    li.className = 'search-option';
    li.setAttribute('role', 'option');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.dataset.kind = place.kind;
    kind.innerHTML = iconId ? icon(iconId) : kindIcon(place.kind);
    const text = document.createElement('span');
    text.className = 'search-text';
    const name = document.createElement('strong');
    this.markMatches(name, place.name, q);
    const meta = document.createElement('span');
    meta.className = 'search-meta';
    if (place.category) {
      const cat = document.createElement('b');
      cat.className = 'search-cat';
      cat.textContent = place.category;
      meta.append(cat, place.detail ? ` · ${place.detail}` : '');
    } else {
      meta.textContent = place.detail;
    }
    text.append(name, meta);
    li.append(kind, text);
    const user = this.o.getUser?.();
    if (user && place.kind !== 'pin') {
      const dist = document.createElement('span');
      dist.className = 'search-dist';
      dist.textContent = formatDistance(haversine(user, place));
      li.append(dist);
    }
    li.addEventListener('click', () => this.choose(index));
    return li;
  }

  private actionRow(index: number, iconId: string, title: string, meta: string): HTMLLIElement {
    const li = document.createElement('li');
    li.id = `hx-result-${index}`;
    li.className = 'search-option search-action';
    li.setAttribute('role', 'option');
    li.innerHTML = `<span class="kind">${icon(iconId)}</span><span class="search-text"><strong></strong><span class="search-meta"></span></span>`;
    li.querySelector('strong')!.textContent = title;
    li.querySelector('.search-meta')!.textContent = meta;
    li.addEventListener('click', () => this.choose(index));
    return li;
  }

  /** Opens the same search in Google Maps; the place comes back as a shared or pasted link. */
  private openGoogleMaps(): void {
    const q = this.o.input.value.trim();
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, '_blank', 'noopener');
    this.o.status.textContent = 'In Google Maps: open the place, tap Share → Copy link, then come back and tap “Paste a Google Maps link”.';
  }

  private async pasteLink(): Promise<void> {
    let text = '';
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      text = '';
    }
    if (!LINK.test(text) && !/-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+/.test(text)) {
      this.o.status.textContent = text
        ? "That isn't a map link. In Google Maps tap Share → Copy link, then try again."
        : 'Copy the link in Google Maps (Share → Copy link), then tap here — or long-press the search box and paste.';
      this.o.input.focus();
      return;
    }
    this.searchFor(text);
  }

  private moreRow(index: number, q: string): HTMLLIElement {
    const li = document.createElement('li');
    li.id = `hx-result-${index}`;
    li.className = 'search-option search-more';
    li.setAttribute('role', 'option');
    li.innerHTML = `<span class="kind">${icon('i-search')}</span><span class="search-text"><strong></strong><span class="search-meta"></span></span>`;
    li.querySelector('strong')!.textContent = `Search more places for “${q}”`;
    li.querySelector('.search-meta')!.textContent = 'Villages, addresses and smaller places';
    li.addEventListener('click', () => this.choose(index));
    return li;
  }

  /** Bolds the parts of the name that match what was typed (at word starts). */
  private markMatches(target: HTMLElement, text: string, q: string): void {
    const tokens = q
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
    const lower = text.toLowerCase();
    const ranges: [number, number][] = [];
    if (lower.length === text.length) {
      for (const t of tokens) {
        let from = lower.indexOf(t);
        while (from !== -1) {
          if (from === 0 || !WORD.test(lower[from - 1])) ranges.push([from, from + t.length]);
          from = lower.indexOf(t, from + t.length);
        }
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const nodes: (string | HTMLElement)[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue;
      if (start > at) nodes.push(text.slice(at, start));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      nodes.push(mark);
      at = end;
    }
    if (at < text.length) nodes.push(text.slice(at));
    target.replaceChildren(...nodes);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.rows.length) return;
      e.preventDefault();
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.rows.length) % this.rows.length;
      this.open();
      this.highlightActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!this.o.panel.hidden && this.active >= 0 && this.rows[this.active]) this.choose(this.active);
      else this.schedule(true);
    } else if (e.key === 'Escape') {
      this.close();
      this.o.input.blur();
    }
  }

  private choose(i: number): void {
    const row = this.rows[i];
    if (!row) return;
    if (row.type === 'more') {
      this.schedule(true);
      return;
    }
    if (row.type === 'google') {
      this.openGoogleMaps();
      return;
    }
    if (row.type === 'paste') {
      void this.pasteLink();
      return;
    }
    this.setValue(row.place.name);
    this.close();
    this.o.input.blur();
    this.o.onSelect(row.place);
  }

  private highlightActive(): void {
    const items = [...this.o.list.querySelectorAll<HTMLElement>('.search-option')];
    items.forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    if (this.active >= 0 && items[this.active]) this.o.input.setAttribute('aria-activedescendant', items[this.active].id);
    else this.o.input.removeAttribute('aria-activedescendant');
  }

  private open(): void {
    if (this.o.panel.hidden) this.o.onOpenChange?.(true);
    this.o.panel.hidden = false;
    this.o.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    if (!this.o.panel.hidden) this.o.onOpenChange?.(false);
    this.o.panel.hidden = true;
    this.o.input.setAttribute('aria-expanded', 'false');
  }
}
