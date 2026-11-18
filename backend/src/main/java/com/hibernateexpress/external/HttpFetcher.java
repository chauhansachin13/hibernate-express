package com.hibernateexpress.external;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/** Makes GET requests. An interface so tests can answer without the network. */
@FunctionalInterface
public interface HttpFetcher {

  /** Status code and body of a response. */
  record Response(int status, String body) {}

  CompletableFuture<Response> get(String url, Duration timeout);
}
