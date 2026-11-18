package com.hibernateexpress.external;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * Expands short Google Maps links (maps.app.goo.gl/…, as shared on WhatsApp) to the full link,
 * which has the coordinates in it. Only Google hosts are contacted, over https, so a pasted link
 * can't make the server fetch anything else.
 */
public interface LinkResolver {

  /** Completes with the final URL, or fails when the link can't be expanded. */
  CompletableFuture<String> expand(String url);

  /** Expands nothing (tests). */
  LinkResolver NONE = url -> CompletableFuture.failedFuture(new IllegalStateException("Short links are off"));

  Pattern SHORT_LINK = Pattern.compile("^https?://(maps\\.app\\.goo\\.gl|goo\\.gl/maps|g\\.co/kgs)/", Pattern.CASE_INSENSITIVE);

  static boolean isShortLink(String url) {
    return url != null && SHORT_LINK.matcher(url.trim()).find();
  }

  /** The JDK implementation: follows up to five redirects, Google hosts only. */
  final class Jdk implements LinkResolver {

    private static final Pattern GOOGLE_HOST =
        Pattern.compile("^(?:[a-z0-9-]+\\.)*(?:google\\.(?:com|co\\.[a-z]{2}|[a-z]{2,3})|goo\\.gl|g\\.co)$");
    private static final int MAX_HOPS = 5;

    private final HttpClient client;
    private final String userAgent;
    private final LruCache<String, String> cache;

    public Jdk(String userAgent, LongSupplier clock) {
      this.userAgent = userAgent;
      this.client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(6)).build();
      this.cache = new LruCache<>(500, 6 * 3600_000L, clock);
    }

    @Override
    public CompletableFuture<String> expand(String url) {
      String start = url.trim();
      if (!isShortLink(start)) return CompletableFuture.failedFuture(new IllegalArgumentException("Not a short map link"));
      String cached = cache.get(start);
      if (cached != null) return CompletableFuture.completedFuture(cached);
      URI uri;
      try {
        uri = URI.create(start.replaceFirst("(?i)^http:", "https:"));
      } catch (IllegalArgumentException e) {
        return CompletableFuture.failedFuture(e);
      }
      return hop(uri, 0).thenApply(result -> {
        cache.put(start, result);
        return result;
      });
    }

    private CompletableFuture<String> hop(URI uri, int depth) {
      if (depth >= MAX_HOPS || !allowed(uri)) return CompletableFuture.completedFuture(uri.toString());
      HttpRequest request =
          HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(8)).header("User-Agent", userAgent).GET().build();
      return client
          .sendAsync(request, HttpResponse.BodyHandlers.discarding())
          .thenCompose(res -> {
            int status = res.statusCode();
            String location = res.headers().firstValue("location").orElse(null);
            if (status / 100 != 3 || location == null) return CompletableFuture.completedFuture(uri.toString());
            return hop(uri.resolve(location.trim()), depth + 1);
          });
    }

    static boolean allowed(URI uri) {
      String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
      return "https".equalsIgnoreCase(uri.getScheme()) && GOOGLE_HOST.matcher(host).matches();
    }
  }
}
