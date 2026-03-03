import { DB_PATH, DEFAULT_HOST, DEFAULT_PORT } from "./config.mts";
import { readDatasetState, syncDataset } from "./gnaf/dataset.mts";
import { ensureDatabaseReady } from "./gnaf/importer.mts";
import { openReadonlyDatabase, readDatabaseMetadata } from "./gnaf/queries.mts";
import { startServer } from "./http/server.mts";
import { pathExists } from "./utils/fs.mts";

interface ParsedArgs {
  command: string;
  forceDownload: boolean;
  forceImport: boolean;
  host?: string;
  port?: number;
}

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
  sync    Download/extract the latest dataset and import it if required.
  update  Alias of sync.
  redownload  Force a fresh dataset download and database rebuild.
  import  Alias of sync.
  status  Show dataset and SQLite import status.
`);
}

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

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  switch (args.command) {
    case "serve":
      await ensureDatabaseReady({
        forceDownload: args.forceDownload,
        forceImport: args.forceImport,
      });
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
