import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { DB_PATH, IMPORT_BATCH_SIZE, PSV_FILE_PATTERNS, SCHEMA_VERSION, SQLITE_DIR } from "../config.mts";
import { ProgressBar, Spinner } from "../terminal/progress.mts";
import { ensureDir, findFilesByNamePattern, pathExists, removePath } from "../utils/fs.mts";
import { joinNonEmpty } from "../utils/strings.mts";
import { streamPsvRows } from "../utils/psv.mts";
import { BUILD_SCHEMA_SQL, SERVE_INDEX_SQL, SERVE_SCHEMA_SQL } from "./schema.mts";
import { syncDataset, type DatasetContext } from "./dataset.mts";

/**
 * Import orchestration flags used by the CLI and server startup.
 */
interface ImportOptions {
  forceDownload?: boolean;
  forceImport?: boolean;
}

/**
 * Metadata read from an existing SQLite database to determine whether the
 * current dataset and schema version have already been imported.
 */
interface ImportMetadata {
  resourceId: string;
  importedAt: string;
  schemaVersion: string;
}

/**
 * Batch writer callback used to flush mapped PSV rows inside a transaction.
 */
type BatchWriter<T> = (rows: T[]) => void;

function get(row: Record<string, string>, key: string): string {
  return row[key] ?? "";
}

function maybeNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function prefer(...values: string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function composeNumber(prefix: string, value: string, suffix: string): string | null {
  return maybeNull(joinNonEmpty([prefix, value, suffix], ""));
}

function composeRange(first: string | null, last: string | null): string | null {
  if (first && last && first !== last) {
    return `${first}-${last}`;
  }
  return first ?? last;
}

function composeAddress(row: {
  buildingName: string | null;
  addressSiteName: string | null;
  flatNumber: string | null;
  levelNumber: string | null;
  lotNumber: string | null;
  numberRange: string | null;
  streetName: string;
  localityName: string;
  stateAbbreviation: string;
  postcode: string | null;
}): string {
  const prefix = joinNonEmpty([
    row.buildingName,
    row.addressSiteName,
    row.levelNumber ? `LEVEL ${row.levelNumber}` : null,
    row.flatNumber ? `FLAT ${row.flatNumber}` : null,
    row.lotNumber ? `LOT ${row.lotNumber}` : null,
  ]);

  const streetPart = joinNonEmpty([row.numberRange, row.streetName]);

  return joinNonEmpty([prefix, streetPart, row.localityName, row.stateAbbreviation, row.postcode]);
}

/**
 * Opens the writable SQLite database with import-oriented pragmas.
 *
 * These pragmas trade some durability during the build phase for substantially
 * better write throughput. The rebuilt database is finalized and swapped into
 * place only after the import completes successfully.
 */
function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hashNormalizedAddress(value: string): Uint8Array {
  return createHash("sha256").update(value).digest().subarray(0, 8);
}

/**
 * Reads the resource metadata from an existing SQLite file so we can decide
 * whether a new import is necessary for the currently resolved dataset.
 */
function readImportMetadata(dbPath: string): ImportMetadata | null {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM metadata WHERE key IN ('resource_id', 'imported_at', 'schema_version')")
      .all();

    const map = new Map(rows.map((row) => [row.key, row.value]));
    const resourceId = map.get("resource_id");
    const importedAt = map.get("imported_at");
    const schemaVersion = map.get("schema_version");
    if (!resourceId || !importedAt || !schemaVersion) {
      return null;
    }

    return { resourceId, importedAt, schemaVersion };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Streams a PSV file, maps each row into a typed import payload, and writes it
 * in transaction-sized batches to keep memory bounded and SQLite fast.
 */
async function withBatchedRows<T>(
  path: string,
  label: string,
  mapRow: (row: Record<string, string>) => T | null,
  writeBatch: BatchWriter<T>,
): Promise<void> {
  const progress = new ProgressBar(label, Bun.file(path).size);
  let batch: T[] = [];

  await streamPsvRows(
    path,
    (row) => {
      const mapped = mapRow(row);
      if (!mapped) {
        return;
      }

      batch.push(mapped);
      if (batch.length >= IMPORT_BATCH_SIZE) {
        writeBatch(batch);
        batch = [];
      }
    },
    (bytesRead) => progress.update(bytesRead),
  );

  if (batch.length > 0) {
    writeBatch(batch);
  }

  progress.finish();
}

/**
 * Applies the same row-mapping/import routine across all shard files for a
 * table family, such as the per-state `ADDRESS_DETAIL` files.
 */
async function importManyFiles<T>(
  paths: string[],
  label: string,
  mapRow: (row: Record<string, string>) => T | null,
  writeBatch: BatchWriter<T>,
): Promise<void> {
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    await withBatchedRows(path, `${label} (${index + 1}/${paths.length})`, mapRow, writeBatch);
  }
}

/**
 * Imports the normalized source tables that mirror the core G-NAF entities
 * required by this tool: states, localities, streets, addresses, and default
 * geocodes.
 *
 * These tables preserve enough structure to support future query refinement,
 * while still being simple enough to rebuild from scratch on each release.
 */
async function importRawTables(db: Database, dataset: DatasetContext): Promise<void> {
  const statePaths = await findFilesByNamePattern(dataset.extractDir, PSV_FILE_PATTERNS.state);
  const localityPaths = await findFilesByNamePattern(dataset.extractDir, PSV_FILE_PATTERNS.locality);
  const streetPaths = await findFilesByNamePattern(dataset.extractDir, PSV_FILE_PATTERNS.streetLocality);
  const addressPaths = await findFilesByNamePattern(dataset.extractDir, PSV_FILE_PATTERNS.addressDetail);
  const geocodePaths = await findFilesByNamePattern(dataset.extractDir, PSV_FILE_PATTERNS.addressDefaultGeocode);

  if (
    statePaths.length === 0 ||
    localityPaths.length === 0 ||
    streetPaths.length === 0 ||
    addressPaths.length === 0 ||
    geocodePaths.length === 0
  ) {
    throw new Error("Unable to locate the expected G-NAF PSV files after extraction");
  }

  const insertStates = db.prepare(
    "INSERT OR REPLACE INTO states (state_pid, state_name, state_abbreviation) VALUES (?, ?, ?)",
  );
  const writeStates = db.transaction((rows: Array<{ pid: string; name: string; abbreviation: string }>) => {
    for (const row of rows) {
      insertStates.run(row.pid, row.name, row.abbreviation);
    }
  });

  await importManyFiles(
    statePaths,
    "Importing states",
    (row) => {
      const pid = get(row, "STATE_PID");
      if (!pid) {
        return null;
      }

      return {
        pid,
        name: get(row, "STATE_NAME"),
        abbreviation: get(row, "STATE_ABBREVIATION"),
      };
    },
    writeStates,
  );

  const insertLocalities = db.prepare(
    "INSERT OR REPLACE INTO localities (locality_pid, locality_name, primary_postcode, state_pid) VALUES (?, ?, ?, ?)",
  );
  const writeLocalities = db.transaction(
    (rows: Array<{ pid: string; name: string; postcode: string | null; statePid: string }>) => {
      for (const row of rows) {
        insertLocalities.run(row.pid, row.name, row.postcode, row.statePid);
      }
    },
  );

  await importManyFiles(
    localityPaths,
    "Importing localities",
    (row) => {
      const pid = get(row, "LOCALITY_PID");
      if (!pid || maybeNull(get(row, "DATE_RETIRED"))) {
        return null;
      }

      return {
        pid,
        name: get(row, "LOCALITY_NAME"),
        postcode: maybeNull(get(row, "PRIMARY_POSTCODE")),
        statePid: get(row, "STATE_PID"),
      };
    },
    writeLocalities,
  );

  const insertStreets = db.prepare(
    "INSERT OR REPLACE INTO streets (street_locality_pid, street_name, street_type_code, street_suffix_code, locality_pid, state_pid, full_street_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const writeStreets = db.transaction(
    (
      rows: Array<{
        pid: string;
        streetName: string;
        streetTypeCode: string | null;
        streetSuffixCode: string | null;
        localityPid: string;
        statePid: string | null;
        fullStreetName: string;
      }>,
    ) => {
      for (const row of rows) {
        insertStreets.run(
          row.pid,
          row.streetName,
          row.streetTypeCode,
          row.streetSuffixCode,
          row.localityPid,
          row.statePid,
          row.fullStreetName,
        );
      }
    },
  );

  await importManyFiles(
    streetPaths,
    "Importing streets",
    (row) => {
      const pid = get(row, "STREET_LOCALITY_PID");
      if (!pid || maybeNull(get(row, "DATE_RETIRED"))) {
        return null;
      }

      const fullStreetName = joinNonEmpty([
        get(row, "STREET_NAME"),
        maybeNull(get(row, "STREET_TYPE_CODE")),
        maybeNull(get(row, "STREET_SUFFIX_CODE")),
      ]);

      return {
        pid,
        streetName: get(row, "STREET_NAME"),
        streetTypeCode: maybeNull(get(row, "STREET_TYPE_CODE")),
        streetSuffixCode: maybeNull(get(row, "STREET_SUFFIX_CODE")),
        localityPid: get(row, "LOCALITY_PID"),
        statePid: maybeNull(get(row, "STATE_PID")),
        fullStreetName,
      };
    },
    writeStreets,
  );

  const insertAddresses = db.prepare(
    "INSERT OR REPLACE INTO addresses (address_detail_pid, building_name, lot_number, flat_number, level_number, number_first, number_last, street_locality_pid, locality_pid, postcode, confidence, alias_principal, address_site_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const writeAddresses = db.transaction(
    (
      rows: Array<{
        pid: string;
        buildingName: string | null;
        lotNumber: string | null;
        flatNumber: string | null;
        levelNumber: string | null;
        numberFirst: string | null;
        numberLast: string | null;
        streetLocalityPid: string;
        localityPid: string;
        postcode: string | null;
        confidence: number | null;
        aliasPrincipal: string | null;
        addressSiteName: string | null;
      }>,
    ) => {
      for (const row of rows) {
        insertAddresses.run(
          row.pid,
          row.buildingName,
          row.lotNumber,
          row.flatNumber,
          row.levelNumber,
          row.numberFirst,
          row.numberLast,
          row.streetLocalityPid,
          row.localityPid,
          row.postcode,
          row.confidence,
          row.aliasPrincipal,
          row.addressSiteName,
        );
      }
    },
  );

  await importManyFiles(
    addressPaths,
    "Importing addresses",
    (row) => {
      const pid = get(row, "ADDRESS_DETAIL_PID");
      if (!pid || maybeNull(get(row, "DATE_RETIRED"))) {
        return null;
      }

      return {
        pid,
        buildingName: prefer(get(row, "BUILDING_NAME")),
        lotNumber: composeNumber(get(row, "LOT_NUMBER_PREFIX"), get(row, "LOT_NUMBER"), get(row, "LOT_NUMBER_SUFFIX")),
        flatNumber: composeNumber(
          get(row, "FLAT_NUMBER_PREFIX"),
          get(row, "FLAT_NUMBER"),
          get(row, "FLAT_NUMBER_SUFFIX"),
        ),
        levelNumber: composeNumber(
          get(row, "LEVEL_NUMBER_PREFIX"),
          get(row, "LEVEL_NUMBER"),
          get(row, "LEVEL_NUMBER_SUFFIX"),
        ),
        numberFirst: composeNumber(
          get(row, "NUMBER_FIRST_PREFIX"),
          get(row, "NUMBER_FIRST"),
          get(row, "NUMBER_FIRST_SUFFIX"),
        ),
        numberLast: composeNumber(
          get(row, "NUMBER_LAST_PREFIX"),
          get(row, "NUMBER_LAST"),
          get(row, "NUMBER_LAST_SUFFIX"),
        ),
        streetLocalityPid: get(row, "STREET_LOCALITY_PID"),
        localityPid: get(row, "LOCALITY_PID"),
        postcode: maybeNull(get(row, "POSTCODE")),
        confidence: maybeNull(get(row, "CONFIDENCE")) ? Number.parseInt(get(row, "CONFIDENCE"), 10) : null,
        aliasPrincipal: maybeNull(get(row, "ALIAS_PRINCIPAL")),
        addressSiteName: prefer(get(row, "ADDRESS_SITE_NAME"), get(row, "LOCATION_DESCRIPTION")),
      };
    },
    writeAddresses,
  );

  const insertGeocodes = db.prepare(
    "INSERT OR REPLACE INTO geocodes (address_detail_pid, latitude, longitude, geocode_type_code) VALUES (?, ?, ?, ?)",
  );
  const writeGeocodes = db.transaction(
    (rows: Array<{ pid: string; latitude: number | null; longitude: number | null; geocodeTypeCode: string | null }>) => {
      for (const row of rows) {
        insertGeocodes.run(row.pid, row.latitude, row.longitude, row.geocodeTypeCode);
      }
    },
  );

  await importManyFiles(
    geocodePaths,
    "Importing geocodes",
    (row) => {
      const pid = get(row, "ADDRESS_DETAIL_PID");
      if (!pid) {
        return null;
      }

      return {
        pid,
        latitude: maybeNull(get(row, "LATITUDE")) ? Number.parseFloat(get(row, "LATITUDE")) : null,
        longitude: maybeNull(get(row, "LONGITUDE")) ? Number.parseFloat(get(row, "LONGITUDE")) : null,
        geocodeTypeCode: maybeNull(get(row, "GEOCODE_TYPE_CODE")),
      };
    },
    writeGeocodes,
  );
}

/**
 * Builds the denormalized read model used by the HTTP API.
 *
 * `search_addresses` stores the final address strings and lookup attributes,
 * while the FTS table supports prefix-style autocomplete queries.
 */
function buildSearchSurface(db: Database): void {
  const spinner = new Spinner("Building search surface");
  spinner.start();

  db.run(`
    INSERT INTO search_addresses (
      address_detail_pid,
      full_address,
      normalized_address,
      normalized_address_hash,
      street_name,
      locality_name,
      state_abbreviation,
      postcode,
      latitude,
      longitude,
      confidence,
      geocode_type_code
    )
    WITH address_parts AS (
      SELECT
        a.address_detail_pid AS address_detail_pid,
        a.building_name AS building_name,
        a.address_site_name AS address_site_name,
        a.flat_number AS flat_number,
        a.level_number AS level_number,
        a.lot_number AS lot_number,
        CASE
          WHEN a.number_first IS NOT NULL AND a.number_last IS NOT NULL AND a.number_first <> a.number_last THEN a.number_first || '-' || a.number_last
          ELSE COALESCE(a.number_first, a.number_last)
        END AS number_range,
        s.full_street_name AS street_name,
        l.locality_name AS locality_name,
        st.state_abbreviation AS state_abbreviation,
        COALESCE(a.postcode, l.primary_postcode) AS postcode,
        g.latitude AS latitude,
        g.longitude AS longitude,
        a.confidence AS confidence,
        g.geocode_type_code AS geocode_type_code
      FROM addresses a
      INNER JOIN streets s ON s.street_locality_pid = a.street_locality_pid
      INNER JOIN localities l ON l.locality_pid = a.locality_pid
      INNER JOIN states st ON st.state_pid = l.state_pid
      LEFT JOIN geocodes g ON g.address_detail_pid = a.address_detail_pid
    ),
    rendered AS (
      SELECT
        address_detail_pid,
        trim(
          (CASE WHEN building_name IS NOT NULL THEN building_name || ' ' ELSE '' END) ||
          (CASE WHEN address_site_name IS NOT NULL THEN address_site_name || ' ' ELSE '' END) ||
          (CASE WHEN level_number IS NOT NULL THEN 'LEVEL ' || level_number || ' ' ELSE '' END) ||
          (CASE WHEN flat_number IS NOT NULL THEN 'FLAT ' || flat_number || ' ' ELSE '' END) ||
          (CASE WHEN lot_number IS NOT NULL THEN 'LOT ' || lot_number || ' ' ELSE '' END) ||
          trim(COALESCE(number_range || ' ', '') || street_name) || ' ' ||
          locality_name || ' ' ||
          state_abbreviation ||
          (CASE WHEN postcode IS NOT NULL THEN ' ' || postcode ELSE '' END)
        ) AS full_address,
        street_name,
        locality_name,
        state_abbreviation,
        postcode,
        latitude,
        longitude,
        confidence,
        geocode_type_code
      FROM address_parts
    )
    SELECT
      address_detail_pid,
      full_address,
      trim(
        replace(replace(replace(replace(replace(replace(replace(lower(full_address), '-', ' '), '/', ' '), ',', ' '), '.', ' '), '(', ' '), ')', ' '), '  ', ' ')
      ) AS normalized_address,
      zeroblob(8) AS normalized_address_hash,
      street_name,
      locality_name,
      state_abbreviation,
      postcode,
      latitude,
      longitude,
      confidence,
      geocode_type_code
    FROM rendered
  `);

  const updateHash = db.prepare("UPDATE search_addresses SET normalized_address_hash = ? WHERE rowid = ?");
  const updateHashes = db.transaction((rows: Array<{ rowid: number; normalizedAddress: string }>) => {
    for (const row of rows) {
      updateHash.run(hashNormalizedAddress(row.normalizedAddress), row.rowid);
    }
  });

  let batch: Array<{ rowid: number; normalizedAddress: string }> = [];
  for (const row of db.query<{ rowid: number; normalizedAddress: string }, []>(
    "SELECT rowid, normalized_address AS normalizedAddress FROM search_addresses",
  ).iterate()) {
    batch.push(row);
    if (batch.length >= IMPORT_BATCH_SIZE) {
      updateHashes(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    updateHashes(batch);
  }

  spinner.stop("done");
}

function emitServeDatabase(buildDbPath: string, serveDbPath: string): void {
  const spinner = new Spinner("Emitting serve-only database");
  spinner.start();

  const serveDb = openDatabase(serveDbPath);
  try {
    serveDb.run(SERVE_SCHEMA_SQL);
    serveDb.run(`ATTACH DATABASE ${sqlStringLiteral(buildDbPath)} AS build`);

    serveDb.run("INSERT INTO metadata (key, value) SELECT key, value FROM build.metadata");
    serveDb.run(`
      INSERT INTO search_addresses (
        address_detail_pid,
        full_address,
        normalized_address,
        normalized_address_hash,
        street_name,
        locality_name,
        state_abbreviation,
        postcode,
        latitude,
        longitude,
        confidence,
        geocode_type_code
      )
      SELECT
        address_detail_pid,
        full_address,
        normalized_address,
        normalized_address_hash,
        street_name,
        locality_name,
        state_abbreviation,
        postcode,
        latitude,
        longitude,
        confidence,
        geocode_type_code
      FROM build.search_addresses
    `);
    serveDb.run(SERVE_INDEX_SQL);
    serveDb.run(`
      INSERT INTO search_fts(rowid, full_address, street_name, locality_name, postcode)
      SELECT rowid, full_address, street_name, locality_name, postcode
      FROM search_addresses
    `);
    serveDb.run("DETACH DATABASE build");
    serveDb.run("PRAGMA wal_checkpoint(TRUNCATE)");
    serveDb.run("PRAGMA journal_mode = DELETE");
  } finally {
    serveDb.close();
  }

  spinner.stop("done");
}

/**
 * Rebuilds the SQLite database from the extracted dataset into a temporary file
 * and atomically swaps it into place when the import completes.
 *
 * This keeps the existing database usable during long imports and avoids
 * exposing a partially built database to the API server.
 */
async function rebuildDatabase(dataset: DatasetContext): Promise<void> {
  await ensureDir(SQLITE_DIR);
  const temporaryBuildDbPath = `${DB_PATH}.build.tmp`;
  const temporaryServeDbPath = `${DB_PATH}.tmp`;
  await removePath(temporaryBuildDbPath);
  await removePath(temporaryServeDbPath);

  const spinner = new Spinner("Preparing SQLite schema");
  spinner.start();
  const db = openDatabase(temporaryBuildDbPath);
  db.run(BUILD_SCHEMA_SQL);
  spinner.stop("done");

  await importRawTables(db, dataset);
  buildSearchSurface(db);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("resource_id", dataset.resource.id);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("resource_name", dataset.resource.name);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("imported_at", new Date().toISOString());
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.run("PRAGMA journal_mode = DELETE");
  db.close();

  emitServeDatabase(temporaryBuildDbPath, temporaryServeDbPath);
  await removePath(DB_PATH);
  await rename(temporaryServeDbPath, DB_PATH);
  await removePath(temporaryBuildDbPath);
}

/**
 * Ensures the local SQLite database matches the latest resolved dataset.
 *
 * This is the main orchestration entrypoint used by both the CLI sync commands
 * and the HTTP server startup path.
 */
export async function ensureDatabaseReady(options: ImportOptions = {}): Promise<DatasetContext> {
  const dataset = await syncDataset({ forceDownload: options.forceDownload });
  const metadata = (await pathExists(DB_PATH)) ? readImportMetadata(DB_PATH) : null;
  const needsImport =
    options.forceImport ||
    !(await pathExists(DB_PATH)) ||
    !metadata ||
    metadata.resourceId !== dataset.resource.id ||
    metadata.schemaVersion !== String(SCHEMA_VERSION);

  if (needsImport) {
    await rebuildDatabase(dataset);
  }

  return dataset;
}
