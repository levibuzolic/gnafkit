import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database } from "bun:sqlite";
import { DB_PATH, SCHEMA_VERSION } from "../config.mts";
import { pathExists } from "../utils/fs.mts";
import { autocomplete, geocode, openReadonlyDatabase } from "./queries.mts";

const ENABLE_REAL_DB_TESTS = process.env.GNAFKIT_TEST_REAL_DB === "1";
const MIN_EXPECTED_FULL_IMPORT_ROWS = 1_000_000;
const SAMPLE_STREET_QUERY = "120 Collins St Melbourne VIC 3000";
const SAMPLE_SUBPREMISE_QUERY = "Unit 1 120 Collins St Melbourne VIC 3000";

/**
 * Minimal metadata needed to confirm the local SQLite database was rebuilt
 * from the full national G-NAF import rather than a partial or stale file.
 */
interface DatabasePreflight {
  schemaVersion: string | null;
  searchAddressCount: number;
  searchFtsCount: number;
}

function readPreflight(db: Database): DatabasePreflight {
  const schemaVersionRow = db
    .query<{ value: string }, []>("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get();
  const searchAddressCount =
    db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM search_addresses").get()?.total ?? 0;
  const searchFtsCount =
    db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM search_fts").get()?.total ?? 0;

  return {
    schemaVersion: schemaVersionRow?.value ?? null,
    searchAddressCount,
    searchFtsCount,
  };
}

/**
 * Ensures opt-in real-database tests fail with a clear rebuild message when the
 * local national import is stale or incomplete.
 */
async function requireCompleteDatabase(): Promise<Database> {
  if (!(await pathExists(DB_PATH))) {
    throw new Error(`Real DB tests require a built database at ${DB_PATH}. Run \`bun run sync\` first.`);
  }

  const db = openReadonlyDatabase();

  try {
    const preflight = readPreflight(db);
    const hasExpectedSchema = preflight.schemaVersion === String(SCHEMA_VERSION);
    const hasFullSearchSurface =
      preflight.searchAddressCount >= MIN_EXPECTED_FULL_IMPORT_ROWS &&
      preflight.searchFtsCount >= MIN_EXPECTED_FULL_IMPORT_ROWS;
    if (!hasExpectedSchema || !hasFullSearchSurface) {
      throw new Error(
        [
          "Real DB tests require a complete national database rebuild.",
          `Expected schema_version=${SCHEMA_VERSION}, found ${preflight.schemaVersion ?? "missing"}.`,
          `search_addresses rows=${preflight.searchAddressCount}.`,
          `search_fts rows=${preflight.searchFtsCount}.`,
          "Run `bun run sync` to rebuild the SQLite database before rerunning tests.",
        ].join(" "),
      );
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const maybeDescribe = ENABLE_REAL_DB_TESTS ? describe : describe.skip;

maybeDescribe("real database queries", () => {
  let db: Database;

  beforeAll(async () => {
    db = await requireCompleteDatabase();
  });

  afterAll(() => {
    db?.close();
  });

  test("autocomplete returns Collins Street Melbourne matches", () => {
    const results = autocomplete(db, SAMPLE_STREET_QUERY, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.fullAddress).toContain("COLLINS STREET MELBOURNE VIC 3000");
    expect(results.some((result) => result.fullAddress === "106-120 COLLINS STREET MELBOURNE VIC 3000")).toBe(true);
  });

  test("geocode resolves common unit synonyms against the canonical flat address", () => {
    const results = geocode(db, SAMPLE_SUBPREMISE_QUERY, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.fullAddress).toBe("FLAT 1 120 COLLINS STREET MELBOURNE VIC 3000");
    expect(results[0]?.stateAbbreviation).toBe("VIC");
    expect(results[0]?.postcode).toBe("3000");
  });
});
