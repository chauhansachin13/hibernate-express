package com.hibernateexpress.trip;

import com.hibernateexpress.geo.LatLng;
import java.util.concurrent.CompletableFuture;

/** Fetches a road route. The future fails when no route can be fetched. */
@FunctionalInterface
public interface RouteProvider {
  CompletableFuture<RouteData> route(LatLng from, LatLng to);
}
