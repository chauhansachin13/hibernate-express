package com.hibernateexpress.external;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/** {@link HttpFetcher} on the JDK's HTTP client (HTTP/2, async, no dependencies). */
public final class JdkHttpFetcher implements HttpFetcher {

  private final HttpClient client;
  private final String userAgent;

  public JdkHttpFetcher(String userAgent) {
    this.userAgent = userAgent;
    this.client =
        HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
  }

  @Override
  public CompletableFuture<Response> get(String url, Duration timeout) {
    HttpRequest request =
        HttpRequest.newBuilder(URI.create(url))
            .timeout(timeout)
            .header("User-Agent", userAgent)
            .header("Accept", "application/json")
            .GET()
            .build();
    return client
        .sendAsync(request, HttpResponse.BodyHandlers.ofString())
        .thenApply(res -> new Response(res.statusCode(), res.body()));
  }
}
