package com.hibernateexpress.external;

import com.hibernateexpress.geo.LatLng;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Place search. An interface so the API can be tested without the network. */
public interface Geocoder {

  /** Type-ahead search, biased towards {@code bias} (may be null). */
  CompletableFuture<List<Place>> search(String query, LatLng bias, int zoom);

  /** Slower, more thorough search used when the user asks for more results. */
  CompletableFuture<List<Place>> searchFallback(String query);

  /** As {@link #searchFallback(String)}, preferring places near {@code bias} (may be null). */
  default CompletableFuture<List<Place>> searchFallback(String query, LatLng bias) {
    return searchFallback(query);
  }

  /** Names a point; completes with null when nothing is known there. */
  CompletableFuture<Place> reverse(LatLng at);
}
