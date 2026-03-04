import { DEFAULT_HOST, DEFAULT_PORT } from "../config.mts";
import { autocomplete, geocode, openReadonlyDatabase, readDatabaseMetadata, reverseGeocode } from "../gnaf/queries.mts";

/**
 * Bind options for the Bun HTTP server.
 */
interface ServerOptions {
  host?: string;
  port?: number;
}

/**
 * Encodes a JSON response with the default content type used by the API.
 */
function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    ...init,
  });
}

/**
 * Convenience wrapper for consistent client-side parameter validation errors.
 */
function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

/**
 * Starts the Bun HTTP server that fronts the SQLite-backed geocoding API.
 *
 * The server intentionally keeps a single read-only database handle open for
 * the process lifetime because the service is read-heavy and SQLite performs
 * best when prepared statements can stay hot inside one process.
 */
export function startServer(options: ServerOptions = {}): void {
  const db = openReadonlyDatabase();
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({
          status: "ok",
          database: readDatabaseMetadata(db),
        });
      }

      if (url.pathname === "/autocomplete") {
        const query = url.searchParams.get("q") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
        return json({
          query,
          results: autocomplete(db, query, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 10),
        });
      }

      if (url.pathname === "/geocode") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) {
          return badRequest("Missing required query parameter: q");
        }

        return json({
          query,
          results: geocode(db, query),
        });
      }

      if (url.pathname === "/reverse-geocode") {
        const latitude = Number.parseFloat(url.searchParams.get("lat") ?? "");
        const longitude = Number.parseFloat(url.searchParams.get("lng") ?? "");
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "5", 10);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return badRequest("Missing or invalid required query parameters: lat, lng");
        }

        return json({
          latitude,
          longitude,
          results: reverseGeocode(db, latitude, longitude, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 5),
        });
      }

      return json(
        {
          service: "gnafkit",
          endpoints: ["/health", "/autocomplete?q=...", "/geocode?q=...", "/reverse-geocode?lat=...&lng=..."],
        },
        { status: 404 },
      );
    },
    error(error) {
      return json({ error: error.message }, { status: 500 });
    },
  });

  process.on("SIGINT", () => {
    server.stop(true);
    db.close();
    process.exit(0);
  });

  console.log(`Serving on http://${host}:${port}`);
}
