import { DB_PATH, DEFAULT_HOST, DEFAULT_PORT, SKIP_SYNC } from "./config.mts";
import { readDatasetState, syncDataset } from "./gnaf/dataset.mts";
import { ensureDatabaseReady } from "./gnaf/importer.mts";
import { openReadonlyDatabase, readDatabaseMetadata } from "./gnaf/queries.mts";
import { startServer } from "./http/server.mts";
import { pathExists } from "./utils/fs.mts";

/**
 * Parsed command-line arguments for the Bun CLI entrypoint.
 */
interface ParsedArgs {
  command: string;
  forceDownload: boolean;
  forceImport: boolean;
  host?: string;
  port?: number;
}

function shouldSkipSync(command: string): boolean {
  return SKIP_SYNC && command === "serve";
}

/**
 * Parses the CLI shape used by `gnafkit`.
 *
 * The parser is intentionally small and explicit because the available commands
 * are limited and tightly coupled to the dataset lifecycle:
 * downloading, importing, serving, and inspecting status.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const [command = "serve", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    process.exit(0);
  }

  let forceDownload = false;
  let forceImport = false;
  let host: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--force-download":
        forceDownload = true;
        break;
      case "--force-import":
        forceImport = true;
        break;
      case "--host":
        host = rest[index + 1];
        index += 1;
        break;
      case "--port":
        port = Number.parseInt(rest[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, forceDownload, forceImport, host, port };
}

/**
 * Prints the supported command surface for the Bun entrypoint.
 */
function printHelp(): void {
  console.log(`gnafkit

Usage:
  bun src/cli.mts serve [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--force-download] [--force-import]
  bun src/cli.mts sync [--force-download] [--force-import]
  bun src/cli.mts update [--force-download] [--force-import]
  bun src/cli.mts redownload
  bun src/cli.mts import [--force-download] [--force-import]
  bun src/cli.mts status

Commands:
  serve   Ensure the latest dataset is ready, then start the HTTP API.
          Set GNAFKIT_SKIP_SYNC=1 to skip dataset sync/import and serve an existing DB_PATH directly.
  sync    Download/extract the latest dataset and import it if required.
  update  Alias of sync.
  redownload  Force a fresh dataset download and database rebuild.
  import  Alias of sync.
  status  Show dataset and SQLite import status.
`);
}

/**
 * Emits a JSON status payload describing the resolved dataset metadata and the
 * currently active SQLite database, if one has been built.
 */
async function handleStatus(): Promise<void> {
  const datasetState = await readDatasetState();
  const databaseExists = await pathExists(DB_PATH);

  console.log(JSON.stringify({
    dataset: datasetState?.current ?? null,
    database: databaseExists
      ? (() => {
          const db = openReadonlyDatabase();
          try {
            return {
              path: DB_PATH,
              metadata: readDatabaseMetadata(db),
            };
          } finally {
            db.close();
          }
        })()
      : null,
  }, null, 2));
}

/**
 * Dispatches the top-level CLI command.
 *
 * `serve` and `sync` both guarantee that the current dataset has been resolved
 * and imported before control returns, which keeps callers from needing to
 * reason about partial initialization states.
 */
async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  switch (args.command) {
    case "serve":
      if (shouldSkipSync(args.command)) {
        if (!(await pathExists(DB_PATH))) {
          throw new Error(`Configured database not found at ${DB_PATH}. Disable GNAFKIT_SKIP_SYNC or provide GNAFKIT_DB_PATH.`);
        }
      } else {
        await ensureDatabaseReady({
          forceDownload: args.forceDownload,
          forceImport: args.forceImport,
        });
      }

      startServer({
        host: args.host ?? DEFAULT_HOST,
        port: args.port ?? DEFAULT_PORT,
      });
      break;
    case "sync":
    case "update":
    case "import":
      await ensureDatabaseReady({
        forceDownload: args.forceDownload,
        forceImport: args.forceImport,
      });
      console.log("Dataset and database are ready.");
      break;
    case "redownload":
      await ensureDatabaseReady({
        forceDownload: true,
        forceImport: true,
      });
      console.log("Dataset was re-downloaded and the database was rebuilt.");
      break;
    case "status":
      await handleStatus();
      break;
    default:
      printHelp();
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
