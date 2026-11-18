package com.hibernateexpress.api;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the built frontend (frontend/dist) with long caching for fingerprinted assets,
 * revalidation for the page and service worker, and the same security headers as production.
 */
final class StaticFiles implements HttpHandler {

  private static final Map<String, String> TYPES =
      Map.ofEntries(
          Map.entry("html", "text/html; charset=utf-8"),
          Map.entry("js", "text/javascript; charset=utf-8"),
          Map.entry("mjs", "text/javascript; charset=utf-8"),
          Map.entry("css", "text/css; charset=utf-8"),
          Map.entry("svg", "image/svg+xml"),
          Map.entry("png", "image/png"),
          Map.entry("jpg", "image/jpeg"),
          Map.entry("ico", "image/x-icon"),
          Map.entry("webmanifest", "application/manifest+json"),
          Map.entry("json", "application/json"),
          Map.entry("woff2", "font/woff2"),
          Map.entry("woff", "font/woff"),
          Map.entry("txt", "text/plain; charset=utf-8"),
          Map.entry("wav", "audio/wav"));

  static final String CSP =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; "
          + "connect-src 'self' https://tile.openstreetmap.org; media-src 'self' blob: data:; "
          + "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; "
          + "form-action 'self'; frame-ancestors 'none'";

  private final Path root;

  StaticFiles(Path root) {
    this.root = root.toAbsolutePath().normalize();
  }

  @Override
  public void handle(HttpExchange ex) throws IOException {
    try {
      String method = ex.getRequestMethod();
      if (!method.equals("GET") && !method.equals("HEAD")) {
        ex.sendResponseHeaders(405, -1);
        return;
      }
      String path = URLDecoder.decode(ex.getRequestURI().getRawPath(), StandardCharsets.UTF_8);
      if (path.endsWith("/")) path += "index.html";
      Path file = root.resolve(path.substring(1)).normalize();
      if (!file.startsWith(root)) {
        ex.sendResponseHeaders(403, -1);
        return;
      }
      if (!Files.isRegularFile(file)) {
        // App routes without a file extension fall back to the single page.
        boolean looksLikeFile = path.substring(path.lastIndexOf('/') + 1).contains(".");
        if (looksLikeFile) {
          ex.sendResponseHeaders(404, -1);
          return;
        }
        file = root.resolve("index.html");
      }
      String name = file.getFileName().toString();
      String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
      var h = ex.getResponseHeaders();
      h.set("Content-Type", TYPES.getOrDefault(ext, "application/octet-stream"));
      h.set("X-Content-Type-Options", "nosniff");
      h.set("Referrer-Policy", "strict-origin-when-cross-origin");
      h.set("X-Frame-Options", "DENY");
      h.set("Permissions-Policy", "geolocation=(self), screen-wake-lock=(self), camera=(), microphone=(), payment=()");
      h.set("Content-Security-Policy", CSP);
      String rel = root.relativize(file).toString().replace('\\', '/');
      if (rel.startsWith("assets/")) h.set("Cache-Control", "public, max-age=31536000, immutable");
      else if (name.equals("index.html") || name.equals("sw.js")) h.set("Cache-Control", "no-cache");
      else h.set("Cache-Control", "public, max-age=3600");

      byte[] bytes = Files.readAllBytes(file);
      if (method.equals("HEAD")) {
        ex.sendResponseHeaders(200, -1);
        return;
      }
      ex.sendResponseHeaders(200, bytes.length);
      try (OutputStream out = ex.getResponseBody()) {
        out.write(bytes);
      }
    } finally {
      ex.close();
    }
  }
}
