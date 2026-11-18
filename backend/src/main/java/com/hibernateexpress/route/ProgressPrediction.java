package com.hibernateexpress.route;

/**
 * Where the vehicle should be by now along the route, and how uncertain that guess is.
 *
 * @param along predicted metres from the route start
 * @param tolerance metres of deviation that are still considered plausible
 */
public record ProgressPrediction(double along, double tolerance) {}
