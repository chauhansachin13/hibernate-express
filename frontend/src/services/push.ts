import { api } from '../api';

/** Whether the alarm can still reach this phone when the screen is off. */
export type ScreenOffAlarm = 'on' | 'needs-permission' | 'unsupported' | 'failed';

/** Push needs a service worker and the Push API (on iPhone: only once added to the Home Screen). */
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export const isIos = (): boolean => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === wanted.length && a.every((v, i) => v === wanted[i]);
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), ms))]);
}

/**
 * The screen-off alarm: subscribes this browser to push and gives the subscription to the trip on
 * the server. Phones pause web pages when the screen locks; the server keeps the trip going and
 * sends the alarm as a notification. Subscribes again when the server's key has changed.
 */
export async function enableScreenOffAlarm(tripId: string): Promise<ScreenOffAlarm> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'needs-permission';
  try {
    const reg = await within(navigator.serviceWorker.ready, 6000);
    const key = keyBytes((await api.pushKey()).publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const res = await api.subscribePush(tripId, sub.toJSON());
    return res.ok ? 'on' : 'failed';
  } catch {
    return 'failed';
  }
}
