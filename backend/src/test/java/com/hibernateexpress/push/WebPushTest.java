package com.hibernateexpress.push;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

public class WebPushTest {

  // RFC 8291, section 5 and appendix A.
  static final String AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  static final String AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  public static final String UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  public static final String UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
  public static final String AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
  static final String SALT = "DGv6ra1nlYgDCS1FRnbzlw";
  static final String PLAINTEXT = "When I grow up, I want to be a watermelon";
  static final String MESSAGE =
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  @Test
  void encryptsExactlyLikeTheRfcExample() {
    KeyPair server = WebPush.keyPair(WebPush.b64d(AS_PUBLIC), WebPush.b64d(AS_PRIVATE));
    byte[] body = WebPush.encrypt(
        PLAINTEXT.getBytes(StandardCharsets.UTF_8), WebPush.b64d(UA_PUBLIC), WebPush.b64d(AUTH), WebPush.b64d(SALT), server);
    assertEquals(MESSAGE, WebPush.b64(body));
  }

  @Test
  void aPhoneCanReadWhatItIsSent() throws Exception {
    KeyPair phone = WebPush.keyPair(WebPush.b64d(UA_PUBLIC), WebPush.b64d(UA_PRIVATE));
    byte[] auth = WebPush.b64d(AUTH);
    String text = "{\"type\":\"alarm\",\"title\":\"Wake up!\"}";
    byte[] body = WebPush.encrypt(text.getBytes(StandardCharsets.UTF_8), WebPush.b64d(UA_PUBLIC), auth);
    assertEquals(text, new String(decrypt(body, phone, auth), StandardCharsets.UTF_8));
    // A fresh salt and server key every time: the same message never looks the same twice.
    assertFalse(Arrays.equals(body, WebPush.encrypt(text.getBytes(StandardCharsets.UTF_8), WebPush.b64d(UA_PUBLIC), auth)));
  }

  @Test
  void signsAVapidTokenThePushServiceCanCheck() throws Exception {
    WebPush push = WebPush.generate("https://hibernate-express.netlify.app");
    String header = push.authorization("https://fcm.googleapis.com/fcm/send/abc123", 1_800_000_000L);
    assertTrue(header.startsWith("vapid t="), header);
    String jwt = header.substring("vapid t=".length(), header.indexOf(", k="));
    assertEquals(push.publicKey(), header.substring(header.indexOf(", k=") + 4));
    String[] parts = jwt.split("\\.");
    String claims = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
    assertTrue(claims.contains("\"aud\":\"https://fcm.googleapis.com\""), claims);
    assertTrue(claims.contains("\"exp\":1800043200"), claims);
    Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
    verifier.initVerify(WebPush.publicKey(WebPush.b64d(push.publicKey())));
    verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
    assertTrue(verifier.verify(Base64.getUrlDecoder().decode(parts[2])));
  }

  @Test
  void onlyPostsToBrowserPushServices() {
    for (String ok : List.of(
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
        "https://web.push.apple.com/QK7abc",
        "https://wns2-par02p.notify.windows.com/w/?token=abc")) {
      assertTrue(WebPush.allowed(ok), ok);
    }
    for (String bad : List.of(
        "http://fcm.googleapis.com/fcm/send/abc",
        "https://evil.example/fcm/send",
        "https://fcm.googleapis.com.evil.example/x",
        "https://169.254.169.254/latest/meta-data",
        "https://user@fcm.googleapis.com/x",
        "not a url")) {
      assertFalse(WebPush.allowed(bad), bad);
    }
  }

  @Test
  void acceptsOnlyRealSubscriptions() {
    Map<String, Object> keys = Map.of("p256dh", UA_PUBLIC, "auth", AUTH);
    PushSubscription sub = PushSubscription.parse(Map.of("endpoint", "https://fcm.googleapis.com/fcm/send/abc", "keys", keys));
    assertEquals(65, sub.p256dh().length);
    assertNull(sub.apiBase());
    assertEquals("https://api.example", PushSubscription.parse(
        Map.of("endpoint", "https://fcm.googleapis.com/fcm/send/abc", "keys", keys, "apiBase", "https://api.example")).apiBase());
    assertThrows(IllegalArgumentException.class, () -> PushSubscription.parse(Map.of("endpoint", "https://evil.example/x", "keys", keys)));
    assertThrows(IllegalArgumentException.class, () -> PushSubscription.parse(
        Map.of("endpoint", "https://fcm.googleapis.com/fcm/send/abc", "keys", Map.of("p256dh", "AAAA", "auth", AUTH))));
    assertThrows(IllegalArgumentException.class, () -> PushSubscription.parse(Map.of("endpoint", "https://fcm.googleapis.com/x")));
  }

  /** What the phone's browser does with a message (RFC 8291 from the receiving side). */
  public static byte[] decrypt(byte[] body, KeyPair phone, byte[] auth) throws Exception {
    ByteBuffer in = ByteBuffer.wrap(body);
    byte[] salt = new byte[16];
    in.get(salt);
    in.getInt();
    byte[] asPublic = new byte[in.get()];
    in.get(asPublic);
    byte[] record = new byte[in.remaining()];
    in.get(record);
    KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
    agreement.init(phone.getPrivate());
    agreement.doPhase(WebPush.publicKey(asPublic), true);
    byte[] ecdh = agreement.generateSecret();
    byte[] uaPublic = WebPush.encode((java.security.interfaces.ECPublicKey) phone.getPublic());
    byte[] prkKey = hmac(auth, ecdh);
    byte[] info = cat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] {0}, uaPublic, asPublic, new byte[] {1});
    byte[] prk = hmac(salt, hmac(prkKey, info));
    byte[] cek = Arrays.copyOf(hmac(prk, cat("Content-Encoding: aes128gcm".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 16);
    byte[] nonce = Arrays.copyOf(hmac(prk, cat("Content-Encoding: nonce".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 12);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
    byte[] padded = cipher.doFinal(record);
    int end = padded.length - 1;
    while (end >= 0 && padded[end] == 0) end--;
    assertEquals(2, padded[end], "last-record delimiter");
    return Arrays.copyOf(padded, end);
  }

  private static byte[] hmac(byte[] key, byte[] data) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(data);
  }

  private static byte[] cat(byte[]... parts) {
    int n = 0;
    for (byte[] p : parts) n += p.length;
    byte[] out = new byte[n];
    int at = 0;
    for (byte[] p : parts) {
      System.arraycopy(p, 0, out, at, p.length);
      at += p.length;
    }
    return out;
  }

  @Test
  void encodesAndRebuildsKeys() throws Exception {
    KeyPair pair = WebPush.newKeyPair();
    byte[] point = WebPush.encode((java.security.interfaces.ECPublicKey) pair.getPublic());
    assertEquals(65, point.length);
    assertArrayEquals(point, WebPush.encode(WebPush.publicKey(point)));
  }
}
