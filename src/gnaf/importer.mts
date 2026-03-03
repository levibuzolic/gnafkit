import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { DB_PATH, IMPORT_BATCH_SIZE, PSV_FILE_PATTERNS, SQLITE_DIR } from "../config.mts";
import { ProgressBar, Spinner } from "../terminal/progress.mts";
import { ensureDir, findFilesByNamePattern, pathExists, removePath } from "../utils/fs.mts";
import { joinNonEmpty, normalizeSearchText } from "../utils/strings.mts";
import { streamPsvRows } from "../utils/psv.mts";
import { INDEX_SQL, RAW_SCHEMA_SQL } from "./schema.mts";
import { syncDataset, type DatasetContext } from "./dataset.mts";

interface ImportOptions {
  forceDownload?: boolean;
  forceImport?: boolean;
}

interface ImportMetadata {
  resourceId: string;
  importedAt: string;
}

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

function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}

function readImportMetadata(dbPath: string): ImportMetadata | null {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM metadata WHERE key IN ('resource_id', 'imported_at')")
      .all();

    const map = new Map(rows.map((row) => [row.key, row.value]));
    const resourceId = map.get("resource_id");
    const importedAt = map.get("imported_at");
    if (!resourceId || !importedAt) {
      return null;
    }

    return { resourceId, importedAt };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

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

function buildSearchSurface(db: Database): void {
  const totalRow = db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM addresses").get();
  const total = totalRow?.total ?? 0;
  const progress = new ProgressBar("Building search index", total);

  const insertSearchAddress = db.prepare(
    "INSERT OR REPLACE INTO search_addresses (address_detail_pid, full_address, normalized_address, street_name, locality_name, state_abbreviation, postcode, latitude, longitude, confidence, geocode_type_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSearchFts = db.prepare(
    "INSERT INTO search_fts (address_detail_pid, full_address, street_name, locality_name, postcode) VALUES (?, ?, ?, ?, ?)",
  );
  const writeBatch = db.transaction(
    (
      rows: Array<{
        pid: string;
        fullAddress: string;
        normalizedAddress: string;
        streetName: string;
        localityName: string;
        stateAbbreviation: string;
        postcode: string | null;
        latitude: number | null;
        longitude: number | null;
        confidence: number | null;
        geocodeTypeCode: string | null;
      }>,
    ) => {
      for (const row of rows) {
        insertSearchAddress.run(
          row.pid,
          row.fullAddress,
          row.normalizedAddress,
          row.streetName,
          row.localityName,
          row.stateAbbreviation,
          row.postcode,
          row.latitude,
          row.longitude,
          row.confidence,
          row.geocodeTypeCode,
        );
        insertSearchFts.run(
          row.pid,
          row.fullAddress,
          row.streetName,
          row.localityName,
          row.postcode,
        );
      }
    },
  );

  const selectRows = db.query<
    {
      addressDetailPid: string;
      buildingName: string | null;
      addressSiteName: string | null;
      flatNumber: string | null;
      levelNumber: string | null;
      lotNumber: string | null;
      numberFirst: string | null;
      numberLast: string | null;
      streetName: string;
      localityName: string;
      stateAbbreviation: string;
      postcode: string | null;
      latitude: number | null;
      longitude: number | null;
      confidence: number | null;
      geocodeTypeCode: string | null;
    },
    []
  >(
    `SELECT
      a.address_detail_pid AS addressDetailPid,
      a.building_name AS buildingName,
      a.address_site_name AS addressSiteName,
      a.flat_number AS flatNumber,
      a.level_number AS levelNumber,
      a.lot_number AS lotNumber,
      a.number_first AS numberFirst,
      a.number_last AS numberLast,
      s.full_street_name AS streetName,
      l.locality_name AS localityName,
      st.state_abbreviation AS stateAbbreviation,
      COALESCE(a.postcode, l.primary_postcode) AS postcode,
      g.latitude AS latitude,
      g.longitude AS longitude,
      a.confidence AS confidence,
      g.geocode_type_code AS geocodeTypeCode
    FROM addresses a
    INNER JOIN streets s ON s.street_locality_pid = a.street_locality_pid
    INNER JOIN localities l ON l.locality_pid = a.locality_pid
    INNER JOIN states st ON st.state_pid = l.state_pid
    LEFT JOIN geocodes g ON g.address_detail_pid = a.address_detail_pid`,
  );

  let processed = 0;
  let batch: Array<{
    pid: string;
    fullAddress: string;
    normalizedAddress: string;
    streetName: string;
    localityName: string;
    stateAbbreviation: string;
    postcode: string | null;
    latitude: number | null;
    longitude: number | null;
    confidence: number | null;
    geocodeTypeCode: string | null;
  }> = [];

  for (const row of selectRows.iterate()) {
    const fullAddress = composeAddress({
      buildingName: row.buildingName,
      addressSiteName: row.addressSiteName,
      flatNumber: row.flatNumber,
      levelNumber: row.levelNumber,
      lotNumber: row.lotNumber,
      numberRange: composeRange(row.numberFirst, row.numberLast),
      streetName: row.streetName,
      localityName: row.localityName,
      stateAbbreviation: row.stateAbbreviation,
      postcode: row.postcode,
    });

    batch.push({
      pid: row.addressDetailPid,
      fullAddress,
      normalizedAddress: normalizeSearchText(fullAddress),
      streetName: row.streetName,
      localityName: row.localityName,
      stateAbbreviation: row.stateAbbreviation,
      postcode: row.postcode,
      latitude: row.latitude,
      longitude: row.longitude,
      confidence: row.confidence,
      geocodeTypeCode: row.geocodeTypeCode,
    });

    processed += 1;
    if (batch.length >= IMPORT_BATCH_SIZE) {
      writeBatch(batch);
      batch = [];
      progress.update(processed);
    }
  }

  if (batch.length > 0) {
    writeBatch(batch);
  }

  progress.finish();
}

async function rebuildDatabase(dataset: DatasetContext): Promise<void> {
  await ensureDir(SQLITE_DIR);
  const temporaryDbPath = `${DB_PATH}.tmp`;
  await removePath(temporaryDbPath);

  const spinner = new Spinner("Preparing SQLite schema");
  spinner.start();
  const db = openDatabase(temporaryDbPath);
  db.run(RAW_SCHEMA_SQL);
  spinner.stop("done");

  await importRawTables(db, dataset);
  buildSearchSurface(db);
  db.run(INDEX_SQL);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("resource_id", dataset.resource.id);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("resource_name", dataset.resource.name);
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("imported_at", new Date().toISOString());
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.run("PRAGMA journal_mode = DELETE");
  db.close();

  await removePath(DB_PATH);
  await rename(temporaryDbPath, DB_PATH);
}

export async function ensureDatabaseReady(options: ImportOptions = {}): Promise<DatasetContext> {
  const dataset = await syncDataset({ forceDownload: options.forceDownload });
  const metadata = (await pathExists(DB_PATH)) ? readImportMetadata(DB_PATH) : null;
  const needsImport =
    options.forceImport ||
    !(await pathExists(DB_PATH)) ||
    !metadata ||
    metadata.resourceId !== dataset.resource.id;

  if (needsImport) {
    await rebuildDatabase(dataset);
  }

  return dataset;
}
