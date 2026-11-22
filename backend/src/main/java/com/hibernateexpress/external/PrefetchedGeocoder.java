package com.hibernateexpress.external;

import com.hibernateexpress.geo.LatLng;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Type-ahead results the phone fetched from Photon itself, used before asking Photon from the
 * server. The public Photon server refuses search requests from some cloud hosts, while each phone
 * searches over its own connection. Look-ups that were neither supplied nor reachable are
 * remembered ("Ameerpet" in "atm in ameerpet"), so the phone can fetch exactly those and ask once
 * more. One per request: nothing a phone sends is cached or shared with other users.
 */
public final class PrefetchedGeocoder implements Geocoder {

  private final Geocoder server;
  private final Map<String, List<Place>> supplied;
  private final Set<String> missing = ConcurrentHashMap.newKeySet();

  public PrefetchedGeocoder(Geocoder server, Map<String, List<Place>> supplied) {
    this.server = server;
    Map<String, List<Place>> byKey = new HashMap<>();
    supplied.forEach((query, places) -> byKey.put(key(query), List.copyOf(places)));
    this.supplied = Map.copyOf(byKey);
  }

  @Override
  public CompletableFuture<List<Place>> search(String query, LatLng bias, int zoom) {
    List<Place> fromPhone = supplied.get(key(query));
    if (fromPhone != null) return CompletableFuture.completedFuture(fromPhone);
    return server.search(query, bias, zoom).whenComplete((places, error) -> {
      if (error != null) missing.add(query.trim());
    });
  }

  @Override
  public CompletableFuture<List<Place>> searchFallback(String query) {
    return server.searchFallback(query);
  }

  @Override
  public CompletableFuture<List<Place>> searchFallback(String query, LatLng bias) {
    return server.searchFallback(query, bias);
  }

  @Override
  public CompletableFuture<Place> reverse(LatLng at) {
    return server.reverse(at);
  }

  /** Type-ahead look-ups the phone should fetch from Photon and send with its next request. */
  public List<String> missing() {
    return missing.stream().sorted().toList();
  }

  private static String key(String query) {
    return query.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
  }
}
