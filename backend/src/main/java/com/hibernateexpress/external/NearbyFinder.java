package com.hibernateexpress.external;

import com.hibernateexpress.geo.LatLng;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/** Closest places of a kind around a point, nearest first. */
@FunctionalInterface
public interface NearbyFinder {

  /** Finds nothing (tests, or when nearby search is switched off). */
  NearbyFinder NONE = (category, center) -> CompletableFuture.completedFuture(List.of());

  CompletableFuture<List<Place>> find(NearbyCategory category, LatLng center);
}
