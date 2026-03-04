# gnafkit

`gnafkit` is a Bun-based toolkit for:

- downloading the latest public Australian G-NAF dataset
- extracting and importing the PSV files into SQLite
- serving a small HTTP API for geocoding and autocomplete

The project is designed around a single-machine, read-heavy workflow:

- first run automatically downloads the dataset if it is not already present
- later runs reuse the local archive and extracted files when they still match the latest published release
- `sync` checks for newer releases
- `redownload` forces a clean dataset fetch and SQLite rebuild

## Runtime

The repo pins the Bun version with `mise`:

```bash
mise install
```

```bash
bun src/cli.mts status
```

## Commands

```bash
# Show current dataset/database status
bun run status

# Download/extract/import if required
bun run sync

# Force a full re-download and rebuild
bun run redownload

# Start the API server, auto-syncing on first run
bun run serve
```

CLI equivalents:

```bash
bun src/cli.mts serve --host 127.0.0.1 --port 3000
bun src/cli.mts sync --force-download --force-import
bun src/cli.mts redownload
bun src/cli.mts status
```

## First-Run Behavior

When you start `serve` or `sync`, `gnafkit` will:

1. query the official `data.gov.au` CKAN metadata API
2. resolve the latest `GDA2020` ZIP resource
3. download the archive into `data/downloads/` if needed
4. extract it into `data/extracted/<resource-id>/`
5. import the required PSV files into `data/sqlite/gnaf.sqlite`

The download and import stages provide terminal progress indicators.

## API

Default server address:

```text
http://127.0.0.1:3000
```

Endpoints:

- `GET /health`
- `GET /autocomplete?q=<text>&limit=10`
- `GET /geocode?q=<full address>`

Examples:

```bash
curl 'http://127.0.0.1:3000/health'
curl 'http://127.0.0.1:3000/autocomplete?q=120%20collins%20melb'
curl 'http://127.0.0.1:3000/geocode?q=120%20Collins%20Street%20Melbourne%20VIC%203000'
```

## Deployment Notes

For production deployments that serve a prebuilt read-only SQLite database:

- set `GNAFKIT_DB_PATH` to the mounted database path
- set `GNAFKIT_SKIP_SYNC=1` so `serve` does not download/import on startup
- optionally set `GNAFKIT_API_KEY` to require a matching request header on every request
- optionally set `GNAFKIT_API_KEY_HEADER` to rename the header, defaulting to `x-api-key`
- ensure the SQLite file already exists at that path before the process starts

Fly.io example values used by this repo's `fly.toml`:

```text
GNAFKIT_DB_PATH=/data/gnaf.sqlite
GNAFKIT_SKIP_SYNC=1
```

Example protected request:

```bash
curl -H 'x-api-key: your-secret-key' 'https://your-app.fly.dev/health'
```

If `GNAFKIT_API_KEY` is set, the homepage at `/` is protected too. That means a normal browser visit will be rejected unless the header is injected by a proxy, browser extension, or an API client.

The included `Dockerfile` starts:

```bash
bun src/cli.mts serve --host 0.0.0.0 --port ${PORT:-3000}
```

That means local development still uses the normal sync/import workflow, while deployment can mount a prebuilt database directly.

### Building DB Artifacts In GitHub Actions

The repository includes a manual workflow at `.github/workflows/build-db.yml` that:

- runs `bun run sync`
- captures dataset/database metadata
- compresses `data/sqlite/gnaf.sqlite` as `zstd`
- publishes the compressed artifact to a dedicated Git LFS branch
- optionally pulls that artifact back down in the deploy job, copies the SQLite file onto the Fly volume, and restarts the app machine

Use a self-hosted or larger runner for that workflow. Standard GitHub-hosted runners are usually too small for a full G-NAF build because the job needs room for the downloaded archive, extracted PSV files, and the final SQLite database at the same time.

Required GitHub Actions secrets and variables for the fully automated path:

- secret `FLY_API_TOKEN` for Machines API start/stop calls
- secret `FLY_SSH_TOKEN` for `fly ssh` / `fly ssh sftp` access during the copy step
- optional secret `GNAFKIT_API_KEY` if the deployed app is header-protected
- optional variable `GNAFKIT_API_KEY_HEADER` if the auth header is not `x-api-key`
- optional variable `APP_BASE_URL` to run a `/health` check after DB deployment

The workflow writes the compressed database to a dedicated branch such as `levi/db-artifacts` under `artifacts/latest/gnaf.sqlite.zst`, alongside `status.json`, `dataset.json`, `version.txt`, and the checksum. Each publish rotates the previous `latest` set into `artifacts/previous/`.

The deploy job assumes a single Fly Machine with the database volume mounted at `/data`, downloads `artifacts/latest/gnaf.sqlite.zst` from the artifact branch, decompresses it on the runner, uploads `gnaf.sqlite` to `/data/incoming/gnaf.sqlite.next`, swaps `/data/gnaf.sqlite`, and restarts the Machine so the Bun process reopens the new database file.

Use an SSH-scoped Fly token for `FLY_SSH_TOKEN`. Fly documents a separate `fly tokens create ssh -a <app>` flow for non-interactive SSH access to one app's Machines.

## Architecture

The source layout is intentionally small and explicit:

- `src/cli.mts`: command parsing and top-level workflows
- `src/gnaf/catalog.mts`: official release discovery
- `src/gnaf/dataset.mts`: download and archive extraction
- `src/gnaf/importer.mts`: PSV ingestion and SQLite build
- `src/gnaf/queries.mts`: read-side SQL for API usage
- `src/http/server.mts`: Bun HTTP server
- `src/utils/`: PSV parsing, normalization, filesystem helpers

SQLite is built in two layers:

- raw normalized tables for the imported source records
- a denormalized `search_addresses` table plus `FTS5` virtual table for API queries

## Notes

- The dataset is large. Expect the initial sync to take time and disk space.
- The SQLite database is rebuilt atomically into a temporary file and swapped into place when import completes.
- The importer currently targets the core PSV files required for address search and geocoding.

## Verification

Basic checks run locally:

```bash
bun test
bunx tsc --noEmit
bun src/cli.mts status
```

## Test Fixtures

Default tests use a tiny checked-in SQLite fixture under `test/fixtures/` so CI does not need to download the full G-NAF dataset.

Re-export that fixture from a fully rebuilt local database with:

```bash
bun run fixture:export
```

If you want to run the live national-database query tests as well:

```bash
bun run sync
bun run test:real-db
```
