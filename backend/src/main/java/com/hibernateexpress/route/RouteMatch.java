package com.hibernateexpress.route;

import com.hibernateexpress.geo.LatLng;

/**
 * Where a position sits on a route.
 *
 * @param segment index of the segment's first vertex
 * @param t position along that segment (0..1)
 * @param point closest point on the route
 * @param distance metres between the query point and the route
 * @param along metres from the route start to {@code point}, measured along the route
 */
public record RouteMatch(int segment, double t, LatLng point, double distance, double along) {}
