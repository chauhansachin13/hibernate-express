package com.hibernateexpress.geo;

/**
 * Closest point of a segment to a query point.
 *
 * @param t position along the segment, 0 = start, 1 = end
 * @param point the closest point
 * @param distance metres from the query point to the segment
 */
public record SegmentProjection(double t, LatLng point, double distance) {}
