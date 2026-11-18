package com.hibernateexpress.api;

import com.hibernateexpress.external.Geocoder;
import com.hibernateexpress.external.LinkResolver;
import com.hibernateexpress.external.NearbyFinder;
import com.hibernateexpress.trip.RouteProvider;
import java.util.function.LongSupplier;

/** What the API needs from the outside world; swapped for fakes in tests. */
public record Services(RouteProvider router, Geocoder geocoder, NearbyFinder nearby, LinkResolver links, LongSupplier wallClock) {

  /** Without nearby search or short-link expansion. */
  public Services(RouteProvider router, Geocoder geocoder, LongSupplier wallClock) {
    this(router, geocoder, NearbyFinder.NONE, LinkResolver.NONE, wallClock);
  }
}
