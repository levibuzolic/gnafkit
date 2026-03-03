import { DEFAULT_HOST, DEFAULT_PORT } from "../config.mts";
import { autocomplete, geocode, openReadonlyDatabase, readDatabaseMetadata, validateAddress } from "../gnaf/queries.mts";

interface ServerOptions {
  host?: string;
  port?: number;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    ...init,
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

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

      if (url.pathname === "/validate") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) {
          return badRequest("Missing required query parameter: q");
        }

        return json({
          query,
          ...validateAddress(db, query),
        });
      }

      return json(
        {
          service: "gnafkit",
          endpoints: ["/health", "/autocomplete?q=...", "/geocode?q=...", "/validate?q=..."],
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
