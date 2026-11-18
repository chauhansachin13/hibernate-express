package com.hibernateexpress.external;

/** Routing failed; {@code noRoute} means the place can't be reached by road at all. */
public final class RoutingException extends RuntimeException {

  private static final long serialVersionUID = 1L;
  private final boolean noRoute;

  public RoutingException(String message, boolean noRoute) {
    super(message);
    this.noRoute = noRoute;
  }

  public boolean noRoute() {
    return noRoute;
  }
}
