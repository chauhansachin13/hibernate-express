package com.hibernateexpress.push;

import java.util.Map;

/**
 * Where to reach one phone's browser: its push service endpoint and its message keys, as the
 * browser's PushSubscription.toJSON() gives them. {@code apiBase} is where this server is reached
 * from that phone, handed back in each message so the notification's buttons can answer it.
 */
public record PushSubscription(String endpoint, byte[] p256dh, byte[] auth, String apiBase) {

  /** Checks what a phone sent; throws IllegalArgumentException with a short reason. */
  public static PushSubscription parse(Map<?, ?> json) {
    Object endpoint = json.get("endpoint");
    Object keys = json.get("keys");
    if (!(endpoint instanceof String e) || e.length() > 2048 || !WebPush.allowed(e)) {
      throw new IllegalArgumentException("Not a browser push subscription");
    }
    if (!(keys instanceof Map<?, ?> k) || !(k.get("p256dh") instanceof String p) || !(k.get("auth") instanceof String a)) {
      throw new IllegalArgumentException("Push keys are missing");
    }
    byte[] p256dh;
    byte[] auth;
    try {
      p256dh = WebPush.b64d(p);
      auth = WebPush.b64d(a);
    } catch (IllegalArgumentException bad) {
      throw new IllegalArgumentException("Push keys aren't valid");
    }
    if (p256dh.length != 65 || p256dh[0] != 4 || auth.length != 16) throw new IllegalArgumentException("Push keys aren't valid");
    String api = json.get("apiBase") instanceof String s && s.length() < 300 && (s.startsWith("https://") || s.startsWith("http://localhost"))
        ? s
        : null;
    return new PushSubscription(e, p256dh, auth, api);
  }
}
