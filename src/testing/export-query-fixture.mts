import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DB_PATH, SCHEMA_VERSION } from "../config.mts";
import { ensureDir, pathExists, removePath, writeJsonFile } from "../utils/fs.mts";
import { SERVE_INDEX_SQL, SERVE_SCHEMA_SQL } from "../gnaf/schema.mts";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures");
const FIXTURE_DB_PATH = join(FIXTURE_DIR, "query-fixture.sqlite");
const FIXTURE_MANIFEST_PATH = join(FIXTURE_DIR, "query-fixture.json");
const FIXTURE_SOURCE_SQL = `
SELECT
  address_detail_pid AS addressDetailPid,
  full_address AS fullAddress,
  normalized_address AS normalizedAddress,
  street_name AS streetName,
  locality_name AS localityName,
  state_abbreviation AS stateAbbreviation,
  postcode,
  latitude,
  longitude,
  confidence,
  geocode_type_code AS geocodeTypeCode
FROM search_addresses
WHERE
  locality_name = 'MELBOURNE' AND
  state_abbreviation = 'VIC' AND
  postcode = '3000' AND
  street_name = 'COLLINS STREET' AND
  (
    full_address = '106-120 COLLINS STREET MELBOURNE VIC 3000' OR
    full_address LIKE 'FLAT % 120 COLLINS STREET MELBOURNE VIC 3000'
  )
ORDER BY full_address, address_detail_pid
LIMIT 32
`;

/**
 * Search-surface row copied from the full national database into the tiny
 * query fixture used by CI and local tests.
 */
interface FixtureAddressRow {
  addressDetailPid: string;
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
}

/**
 * Stable test inputs and expectations written alongside the fixture database so
 * tests can assert against the exact exported sample rather than hardcoded
 * assumptions spread across multiple files.
 */
interface QueryFixtureManifest {
  schemaVersion: number;
  exportedAt: string;
  sourceDatabasePath: string;
  sourceSql: string;
  totalRows: number;
  sampleQueries: {
    autocomplete: {
      query: string;
      expectedAny: string[];
    };
    geocode: {
      query: string;
      expectedFirst: string;
    };
  };
}

function requireRow<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

/**
 * Ensures the local source database exists and exposes the query-facing search
 * tables needed to export the tiny CI fixture.
 */
async function openSourceDatabase(): Promise<Database> {
  if (!(await pathExists(DB_PATH))) {
    throw new Error(`Cannot export fixture: source database not found at ${DB_PATH}. Run \`bun run sync\` first.`);
  }

  const db = new Database(DB_PATH, { readonly: true, strict: true });
  const searchAddressesPresent = db
    .query<{ present: number }, []>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'search_addresses'",
    )
    .get()?.present === 1;
  const searchFtsPresent = db
    .query<{ present: number }, []>("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'")
    .get()?.present === 1;

  if (!searchAddressesPresent || !searchFtsPresent) {
    db.close();
    throw new Error(
      "Cannot export fixture: source database is missing query tables. Run `bun run sync` first.",
    );
  }

  return db;
}

/**
 * Copies a deterministic subset of query-facing rows into a tiny standalone
 * SQLite file that can be committed and exercised in CI without downloading the
 * full G-NAF release.
 */
async function exportQueryFixture(): Promise<void> {
  const sourceDb = await openSourceDatabase();

  try {
    const rows = sourceDb.query<FixtureAddressRow, []>(FIXTURE_SOURCE_SQL).all();
    if (rows.length < 10) {
      throw new Error(`Fixture export query returned only ${rows.length} rows; expected at least 10 rows.`);
    }

    const geocodeSample = requireRow(
      rows.find((row) => row.fullAddress === "FLAT 1 120 COLLINS STREET MELBOURNE VIC 3000"),
      "Fixture export query did not include the expected geocode sample row.",
    );

    await ensureDir(dirname(FIXTURE_DB_PATH));
    if (await pathExists(FIXTURE_DB_PATH)) {
      await removePath(FIXTURE_DB_PATH);
    }

    const fixtureDb = new Database(FIXTURE_DB_PATH, { create: true, strict: true });
    try {
      fixtureDb.run(SERVE_SCHEMA_SQL);
      fixtureDb.run(SERVE_INDEX_SQL);

      const insertMetadata = fixtureDb.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
      insertMetadata.run("schema_version", String(SCHEMA_VERSION));
      insertMetadata.run("resource_id", "fixture");
      insertMetadata.run("resource_name", "query fixture");
      insertMetadata.run("imported_at", new Date().toISOString());

      const insertSearchAddress = fixtureDb.prepare(
        "INSERT INTO search_addresses (address_detail_pid, full_address, normalized_address, normalized_address_hash, street_name, locality_name, state_abbreviation, postcode, latitude, longitude, confidence, geocode_type_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertSearchFts = fixtureDb.prepare(
        "INSERT INTO search_fts (rowid, full_address, street_name, locality_name, postcode) VALUES (?, ?, ?, ?, ?)",
      );

      const writeRows = fixtureDb.transaction((fixtureRows: FixtureAddressRow[]) => {
        for (const row of fixtureRows) {
          const searchAddressInsert = insertSearchAddress.run(
            row.addressDetailPid,
            row.fullAddress,
            row.normalizedAddress,
            createHash("sha256").update(row.normalizedAddress).digest().subarray(0, 8),
            row.streetName,
            row.localityName,
            row.stateAbbreviation,
            row.postcode,
            row.latitude,
            row.longitude,
            row.confidence,
            row.geocodeTypeCode,
          );
          const searchAddressRowid = Number(searchAddressInsert.lastInsertRowid);
          insertSearchFts.run(
            searchAddressRowid,
            row.fullAddress,
            row.streetName,
            row.localityName,
            row.postcode,
          );
        }
      });

      writeRows(rows);
      fixtureDb.run("PRAGMA wal_checkpoint(TRUNCATE)");
      fixtureDb.run("PRAGMA journal_mode = DELETE");
    } finally {
      fixtureDb.close();
    }

    const manifest: QueryFixtureManifest = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      sourceDatabasePath: DB_PATH,
      sourceSql: FIXTURE_SOURCE_SQL.trim(),
      totalRows: rows.length,
      sampleQueries: {
        autocomplete: {
          query: "120 Collins Street Melbourne VIC 3000",
          expectedAny: [
            "106-120 COLLINS STREET MELBOURNE VIC 3000",
            "FLAT 1 120 COLLINS STREET MELBOURNE VIC 3000",
          ],
        },
        geocode: {
          query: geocodeSample.fullAddress,
          expectedFirst: geocodeSample.fullAddress,
        },
      },
    };

    await writeJsonFile(FIXTURE_MANIFEST_PATH, manifest);
    await removePath(`${FIXTURE_DB_PATH}-shm`);
    await removePath(`${FIXTURE_DB_PATH}-wal`);
    console.log(`Exported ${rows.length} query fixture rows to ${FIXTURE_DB_PATH}`);
  } finally {
    sourceDb.close();
  }
}

await exportQueryFixture();
