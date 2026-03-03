import { Database } from "bun:sqlite";
import { DB_PATH } from "../config.mts";
import { buildFtsPrefixQuery, normalizeSearchText } from "../utils/strings.mts";

export interface AddressRecord {
  addressDetailPid: string;
  fullAddress: string;
  streetName: string;
  localityName: string;
  stateAbbreviation: string;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  confidence: number | null;
  geocodeTypeCode: string | null;
}

export function openReadonlyDatabase(): Database {
  return new Database(DB_PATH, { readonly: true, strict: true });
}

export function autocomplete(
  db: Database,
  query: string,
  limit = 10,
): AddressRecord[] {
  const ftsQuery = buildFtsPrefixQuery(query);
  if (!ftsQuery) {
    return [];
  }

  return db
    .query<AddressRecord, [string, number]>(
      `SELECT
        s.address_detail_pid AS addressDetailPid,
        s.full_address AS fullAddress,
        s.street_name AS streetName,
        s.locality_name AS localityName,
        s.state_abbreviation AS stateAbbreviation,
        s.postcode AS postcode,
        s.latitude AS latitude,
        s.longitude AS longitude,
        s.confidence AS confidence,
        s.geocode_type_code AS geocodeTypeCode
      FROM search_fts f
      INNER JOIN search_addresses s ON s.address_detail_pid = f.address_detail_pid
      WHERE search_fts MATCH ?
      ORDER BY bm25(search_fts, 2.0, 1.0, 0.8, 0.4), s.confidence DESC, s.full_address
      LIMIT ?`,
    )
    .all(ftsQuery, limit);
}

export function geocode(
  db: Database,
  query: string,
  limit = 5,
): AddressRecord[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return [];
  }

  const exact = db
    .query<AddressRecord, [string, number]>(
      `SELECT
        address_detail_pid AS addressDetailPid,
        full_address AS fullAddress,
        street_name AS streetName,
        locality_name AS localityName,
        state_abbreviation AS stateAbbreviation,
        postcode,
        latitude,
        longitude,
        confidence,
        geocode_type_code AS geocodeTypeCode
      FROM search_addresses
      WHERE normalized_address = ?
      ORDER BY confidence DESC, full_address
      LIMIT ?`,
    )
    .all(normalized, limit);

  if (exact.length > 0) {
    return exact;
  }

  return autocomplete(db, query, limit);
}

export function validateAddress(
  db: Database,
  query: string,
): { valid: boolean; match: AddressRecord | null } {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return { valid: false, match: null };
  }

  const match =
    db
      .query<AddressRecord, [string]>(
        `SELECT
          address_detail_pid AS addressDetailPid,
          full_address AS fullAddress,
          street_name AS streetName,
          locality_name AS localityName,
          state_abbreviation AS stateAbbreviation,
          postcode,
          latitude,
          longitude,
          confidence,
          geocode_type_code AS geocodeTypeCode
        FROM search_addresses
        WHERE normalized_address = ?
        ORDER BY confidence DESC, full_address
        LIMIT 1`,
      )
      .get(normalized) ?? null;

  return { valid: match !== null, match };
}

export function readDatabaseMetadata(db: Database): Record<string, string> {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM metadata ORDER BY key").all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
