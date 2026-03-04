import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database, type Database as DatabaseType } from "bun:sqlite";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../config.mts";
import { pathExists, readJsonFile } from "../utils/fs.mts";
import { autocomplete, geocode, reverseGeocode } from "./queries.mts";

const FIXTURE_DB_PATH = join(process.cwd(), "test", "fixtures", "query-fixture.sqlite");
const FIXTURE_MANIFEST_PATH = join(process.cwd(), "test", "fixtures", "query-fixture.json");

/**
 * Fixture metadata written by the export script so tests assert against the
 * exact sample that was copied out of the real national database.
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
    reverseGeocode: {
      latitude: number;
      longitude: number;
      expectedAny: string[];
      maxDistanceMeters: number;
    };
  };
}

/**
 * Opens the checked-in query fixture and validates its manifest so CI failures
 * point at the fixture export workflow rather than surfacing opaque SQL errors.
 */
async function openFixtureDatabase(): Promise<{ db: DatabaseType; manifest: QueryFixtureManifest }> {
  if (!(await pathExists(FIXTURE_DB_PATH)) || !(await pathExists(FIXTURE_MANIFEST_PATH))) {
    throw new Error(
      `Query fixture files are missing. Recreate them with \`bun src/testing/export-query-fixture.mts\`.`,
    );
  }

  const manifest = await readJsonFile<QueryFixtureManifest>(FIXTURE_MANIFEST_PATH);
  if (!manifest) {
    throw new Error(`Unable to read query fixture manifest at ${FIXTURE_MANIFEST_PATH}.`);
  }

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Query fixture schema_version=${manifest.schemaVersion} does not match current schema_version=${SCHEMA_VERSION}. Re-export the fixture.`,
    );
  }

  if (manifest.totalRows < 10) {
    throw new Error(`Query fixture is too small (${manifest.totalRows} rows). Re-export the fixture.`);
  }

  return {
    db: new Database(FIXTURE_DB_PATH, { readonly: true, strict: true }),
    manifest,
  };
}

describe("fixture-backed query lookups", () => {
  let db: DatabaseType;
  let manifest: QueryFixtureManifest;

  beforeAll(async () => {
    const fixture = await openFixtureDatabase();
    db = fixture.db;
    manifest = fixture.manifest;
  });

  afterAll(() => {
    db?.close();
  });

  test("autocomplete returns expected Collins Street matches", () => {
    const results = autocomplete(db, manifest.sampleQueries.autocomplete.query, 5);

    expect(results.length).toBeGreaterThan(0);
    for (const expectedAddress of manifest.sampleQueries.autocomplete.expectedAny) {
      expect(results.some((result) => result.fullAddress === expectedAddress)).toBe(true);
    }
  });

  test("geocode resolves the canonical sample address", () => {
    const results = geocode(db, manifest.sampleQueries.geocode.query, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.fullAddress).toBe(manifest.sampleQueries.geocode.expectedFirst);
  });

  test("reverse geocode returns the expected nearby fixture addresses", () => {
    const reverseSample = manifest.sampleQueries.reverseGeocode;
    const results = reverseGeocode(db, reverseSample.latitude, reverseSample.longitude, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.distanceMeters).toBeLessThan(reverseSample.maxDistanceMeters);
    expect(reverseSample.expectedAny.some((expectedAddress) => results.some((result) => result.fullAddress === expectedAddress))).toBe(true);
  });
});
