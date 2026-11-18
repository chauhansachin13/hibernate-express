package com.hibernateexpress.api;

/** An error with an HTTP status and a message that is safe to show to users. */
public final class ApiError extends RuntimeException {

  private static final long serialVersionUID = 1L;
  private final int status;

  public ApiError(int status, String message) {
    super(message);
    this.status = status;
  }

  public int status() {
    return status;
  }

  public static ApiError badRequest(String message) {
    return new ApiError(400, message);
  }

  public static ApiError notFound(String message) {
    return new ApiError(404, message);
  }
}
