package com.hibernateexpress.push;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Web Push on the JDK alone: VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291,
 * RFC 8188). It lets the server reach a phone whose browser has paused the page — screen locked or
 * the app in the background — so the alarm still arrives, as a notification.
 */
public final class WebPush {

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final ECParameterSpec P256 = p256();
  private static final int RECORD_SIZE = 4096;

  private final KeyPair vapid;
  private final byte[] vapidPublic;
  private final String subject;

  public WebPush(KeyPair vapid, String subject) {
    this.vapid = vapid;
    this.vapidPublic = encode((ECPublicKey) vapid.getPublic());
    this.subject = subject;
  }

  /** A fresh VAPID key pair (phones re-subscribe when the server's key changes). */
  public static WebPush generate(String subject) {
    return new WebPush(newKeyPair(), subject);
  }

  /** Keys from base64url text: the public key as an uncompressed point, the private key raw. */
  public static WebPush fromKeys(String publicKey, String privateKey, String subject) {
    return new WebPush(keyPair(b64d(publicKey), b64d(privateKey)), subject);
  }

  /** The application server key phones subscribe with (base64url, uncompressed P-256 point). */
  public String publicKey() {
    return b64(vapidPublic);
  }

  /** Whether an endpoint belongs to a browser push service: the server never posts anywhere else. */
  public static boolean allowed(String endpoint) {
    try {
      URI u = URI.create(endpoint);
      if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null) return false;
      String host = u.getHost().toLowerCase(Locale.ROOT);
      return host.equals("fcm.googleapis.com")
          || host.equals("updates.push.services.mozilla.com")
          || host.equals("web.push.apple.com")
          || host.endsWith(".push.apple.com")
          || host.endsWith(".notify.windows.com");
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  /** The POST that delivers {@code payload} to a subscription (expires after {@code ttlSeconds}). */
  public HttpRequest request(PushSubscription sub, byte[] payload, int ttlSeconds, long nowSeconds) {
    if (!allowed(sub.endpoint())) throw new IllegalArgumentException("Not a push service endpoint");
    byte[] body = encrypt(payload, sub.p256dh(), sub.auth());
    return HttpRequest.newBuilder(URI.create(sub.endpoint()))
        .timeout(Duration.ofSeconds(10))
        .header("TTL", String.valueOf(ttlSeconds))
        .header("Urgency", "high")
        .header("Topic", "hx-alarm")
        .header("Content-Type", "application/octet-stream")
        .header("Content-Encoding", "aes128gcm")
        .header("Authorization", authorization(sub.endpoint(), nowSeconds))
        .POST(HttpRequest.BodyPublishers.ofByteArray(body))
        .build();
  }

  /** "vapid t=JWT, k=key" for the push service that owns {@code endpoint}. */
  public String authorization(String endpoint, long nowSeconds) {
    URI u = URI.create(endpoint);
    String audience = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    String header = b64("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.UTF_8));
    String claims = b64(("{\"aud\":\"" + audience + "\",\"exp\":" + (nowSeconds + 12 * 3600) + ",\"sub\":\"" + subject + "\"}")
        .getBytes(StandardCharsets.UTF_8));
    String signingInput = header + "." + claims;
    try {
      Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
      signer.initSign(vapid.getPrivate());
      signer.update(signingInput.getBytes(StandardCharsets.US_ASCII));
      return "vapid t=" + signingInput + "." + b64(signer.sign()) + ", k=" + publicKey();
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("Couldn't sign the push request", e);
    }
  }

  /** Encrypts for one phone with a fresh salt and a fresh server key pair, as RFC 8291 requires. */
  public static byte[] encrypt(byte[] plaintext, byte[] uaPublic, byte[] authSecret) {
    byte[] salt = new byte[16];
    RANDOM.nextBytes(salt);
    return encrypt(plaintext, uaPublic, authSecret, salt, newKeyPair());
  }

  /** RFC 8291 section 3: ECDH, then HKDF into a content key and nonce, then one aes128gcm record. */
  static byte[] encrypt(byte[] plaintext, byte[] uaPublic, byte[] authSecret, byte[] salt, KeyPair server) {
    try {
      byte[] asPublic = encode((ECPublicKey) server.getPublic());
      KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
      agreement.init(server.getPrivate());
      agreement.doPhase(publicKey(uaPublic), true);
      byte[] ecdhSecret = agreement.generateSecret();
      byte[] prkKey = hmac(authSecret, ecdhSecret);
      byte[] keyInfo = concat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] {0}, uaPublic, asPublic);
      byte[] ikm = hmac(prkKey, concat(keyInfo, new byte[] {1}));
      byte[] prk = hmac(salt, ikm);
      byte[] cek = Arrays.copyOf(hmac(prk, concat("Content-Encoding: aes128gcm".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 16);
      byte[] nonce = Arrays.copyOf(hmac(prk, concat("Content-Encoding: nonce".getBytes(StandardCharsets.US_ASCII), new byte[] {0, 1})), 12);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
      byte[] record = cipher.doFinal(concat(plaintext, new byte[] {2})); // 0x02: last record, no padding
      ByteBuffer header = ByteBuffer.allocate(16 + 4 + 1 + asPublic.length);
      header.put(salt).putInt(RECORD_SIZE).put((byte) asPublic.length).put(asPublic);
      return concat(header.array(), record);
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("Couldn't encrypt the push message", e);
    }
  }

  // ------------------------------------------------------------------ keys

  static KeyPair newKeyPair() {
    try {
      KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
      generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
      return generator.generateKeyPair();
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("P-256 is not available", e);
    }
  }

  public static KeyPair keyPair(byte[] uncompressedPublic, byte[] rawPrivate) {
    try {
      KeyFactory factory = KeyFactory.getInstance("EC");
      return new KeyPair(publicKey(uncompressedPublic), factory.generatePrivate(new ECPrivateKeySpec(new BigInteger(1, rawPrivate), P256)));
    } catch (GeneralSecurityException e) {
      throw new IllegalArgumentException("Not a P-256 key pair", e);
    }
  }

  static ECPublicKey publicKey(byte[] point) throws GeneralSecurityException {
    if (point.length != 65 || point[0] != 4) throw new GeneralSecurityException("Not an uncompressed P-256 point");
    BigInteger x = new BigInteger(1, Arrays.copyOfRange(point, 1, 33));
    BigInteger y = new BigInteger(1, Arrays.copyOfRange(point, 33, 65));
    return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), P256));
  }

  static byte[] encode(ECPublicKey key) {
    return concat(new byte[] {4}, fixed32(key.getW().getAffineX()), fixed32(key.getW().getAffineY()));
  }

  private static byte[] fixed32(BigInteger n) {
    byte[] raw = n.toByteArray();
    byte[] out = new byte[32];
    int copy = Math.min(32, raw.length);
    System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
    return out;
  }

  private static ECParameterSpec p256() {
    try {
      AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
      params.init(new ECGenParameterSpec("secp256r1"));
      return params.getParameterSpec(ECParameterSpec.class);
    } catch (GeneralSecurityException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  // ------------------------------------------------------------------ bytes

  private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(data);
  }

  private static byte[] concat(byte[]... parts) {
    int length = 0;
    for (byte[] p : parts) length += p.length;
    byte[] out = new byte[length];
    int at = 0;
    for (byte[] p : parts) {
      System.arraycopy(p, 0, out, at, p.length);
      at += p.length;
    }
    return out;
  }

  static String b64(byte[] bytes) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  public static byte[] b64d(String text) {
    return Base64.getUrlDecoder().decode(text.trim().replace('+', '-').replace('/', '_').replace("=", ""));
  }
}
