package com.hibernateexpress.push;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/** Posts a push message; completes with the push service's HTTP status (404/410 = gone). */
public interface PushSender {

  CompletableFuture<Integer> send(HttpRequest request);

  /** The real one, on the JDK's HTTP client. */
  static PushSender jdk() {
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    return request -> client.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenApply(HttpResponse::statusCode);
  }
}
