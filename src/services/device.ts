/** Screen wake lock, notifications and local storage helpers. */

export class ScreenWakeLock {
  readonly supported = 'wakeLock' in navigator;
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private readonly listeners = new Set<(active: boolean) => void>();

  constructor() {
    // The browser releases the lock whenever the page is hidden; take it back.
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.acquire();
    });
  }

  get active(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  onChange(listener: (active: boolean) => void): void {
    this.listeners.add(listener);
  }

  async enable(): Promise<boolean> {
    this.wanted = true;
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      // Already released.
    }
    this.notify();
  }

  private async acquire(): Promise<boolean> {
    if (!this.supported || document.visibilityState !== 'visible') return false;
    if (this.active) return true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
        this.notify();
      });
      this.notify();
      return true;
    } catch {
      this.notify();
      return false;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.active);
  }
}

export type PermissionState = NotificationPermission | 'unsupported';

export function notificationPermission(): PermissionState {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Shows a notification through the service worker when possible (needed on Android). */
export async function notify(title: string, body: string, opts: { tag: string; urgent?: boolean }): Promise<void> {
  if (notificationPermission() !== 'granted') return;
  const base = {
    body,
    tag: opts.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    requireInteraction: !!opts.urgent,
    renotify: true,
    vibrate: opts.urgent ? [600, 250, 600, 250, 900] : undefined,
    data: { url: '/' },
  };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      const actions = opts.urgent ? [{ action: 'stop', title: "I'm awake" }] : [];
      await reg.showNotification(title, { ...base, actions } as NotificationOptions);
      return;
    }
  } catch {
    // Fall through to a page notification.
  }
  try {
    new Notification(title, base as NotificationOptions);
  } catch {
    // Some mobile browsers only allow service-worker notifications.
  }
}

export async function clearNotifications(tag: string): Promise<void> {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const list = await reg?.getNotifications({ tag });
    list?.forEach((n) => n.close());
  } catch {
    // Nothing to clear.
  }
}

export const KEYS = {
  settings: 'hx.settings.v1',
  recents: 'hx.recents.v1',
  trip: 'hx.trip.v1',
  mapStyle: 'hx.map-style.v1',
} as const;

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: the app still works, it just won't remember.
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}
