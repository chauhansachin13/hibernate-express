package com.hibernateexpress;

import com.hibernateexpress.api.ApiServer;
import com.hibernateexpress.api.Services;
import com.hibernateexpress.external.GeocodingClient;
import com.hibernateexpress.external.HttpFetcher;
import com.hibernateexpress.external.JdkHttpFetcher;
import com.hibernateexpress.external.LinkResolver;
import com.hibernateexpress.external.OsrmClient;
import com.hibernateexpress.sim.AccuracyReport;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.LongSupplier;

/**
 * Entry point.
 *
 * <pre>
 *   java -jar hibernate-express.jar serve [--port 8080] [--static ../frontend/dist]
 *   java -jar hibernate-express.jar accuracy [../docs/ACCURACY.md]
 * </pre>
 *
 * Environment: PORT, HX_STATIC (frontend build to serve), HX_ALLOWED_ORIGIN (CORS, default *).
 */
public final class Main {

  private static final String USAGE =
      """
      Hibernate Express backend
        serve [--port 8080] [--static ../frontend/dist]   run the API (and serve the frontend)
        accuracy [../docs/ACCURACY.md]                     run the accuracy simulation
      """;

  private Main() {}

  public static void main(String[] args) throws Exception {
    String command = args.length > 0 ? args[0] : "serve";
    switch (command) {
      case "serve" -> serve(args);
      case "accuracy" -> AccuracyReport.write(Path.of(args.length > 1 ? args[1] : "../docs/ACCURACY.md"));
      default -> {
        System.err.print(USAGE);
        System.exit(2);
      }
    }
  }

  private static void serve(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    String staticDir = System.getenv("HX_STATIC");
    for (int i = 1; i < args.length - 1; i++) {
      if (args[i].equals("--port")) port = Integer.parseInt(args[i + 1]);
      if (args[i].equals("--static")) staticDir = args[i + 1];
    }
    Path staticRoot = null;
    if (staticDir != null && Files.isDirectory(Path.of(staticDir))) staticRoot = Path.of(staticDir);
    else if (staticDir == null && Files.isDirectory(Path.of("../frontend/dist"))) staticRoot = Path.of("../frontend/dist");

    LongSupplier clock = System::currentTimeMillis;
    HttpFetcher http = new JdkHttpFetcher("HibernateExpress/1.0 (bus stop alarm)");
    GeocodingClient photon = new GeocodingClient(http, clock);
    Services services =
        new Services(
            new OsrmClient(http, clock),
            photon,
            photon,
            new LinkResolver.Jdk("HibernateExpress/1.0 (bus stop alarm)", clock),
            clock);
    ApiServer server = new ApiServer(new InetSocketAddress(port), services, staticRoot, System.getenv("HX_ALLOWED_ORIGIN"));
    server.start();
    Runtime.getRuntime().addShutdownHook(new Thread(server::stop, "hx-shutdown"));
    System.out.println(
        "Hibernate Express backend on http://localhost:" + server.port()
            + (staticRoot != null ? " (serving " + staticRoot.toAbsolutePath().normalize() + ")" : " (API only)"));
  }
}
