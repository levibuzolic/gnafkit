import { Database } from "bun:sqlite";
import { DB_PATH } from "../config.mts";
import { buildAddressFtsPrefixQueries, extractLeadingSubpremise, normalizeAddressInput, streetNameVariants } from "./address-aliases.mts";

/**
 * Canonical address record returned by forward-search endpoints.
 */
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

/**
 * Reverse-geocode result augmented with runtime-calculated distance from the
 * query coordinate.
 */
export interface ReverseGeocodeRecord extends AddressRecord {
  distanceMeters: number;
}

const STATE_ABBREVIATIONS = new Set(["ACT", "NSW", "NT", "OT", "QLD", "SA", "TAS", "VIC", "WA"]);
const SUBPREMISE_PATTERN = /\b(flat|unit|level|lot|suite|shop|room)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractQueryPostcode(query: string): string | null {
  const match = normalizeAddressInput(query).match(/\b(\d{4})\b(?!.*\b\d{4}\b)/);
  return match?.[1] ?? null;
}

function extractQueryState(query: string): string | null {
  const tokens = normalizeAddressInput(query).split(" ");
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (STATE_ABBREVIATIONS.has(upper)) {
      return upper;
    }
  }

  return null;
}

function extractStreetNumberRange(text: string, streetName: string): { first: number; last: number } | null {
  const normalizedText = normalizeAddressInput(text);
  const variants = streetNameVariants(streetName);
  let match: RegExpMatchArray | null = null;

  for (const variant of variants) {
    const pattern = new RegExp(`\\b(\\d+)(?:-(\\d+))?\\s+${escapeRegExp(variant)}\\b`);
    match = normalizedText.match(pattern);
    if (match) {
      break;
    }
  }

  if (!match) {
    return null;
  }

  const first = Number.parseInt(match[1] ?? "", 10);
  const last = Number.parseInt(match[2] ?? match[1] ?? "", 10);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return null;
  }

  return {
    first: Math.min(first, last),
    last: Math.max(first, last),
  };
}

function queryMatchesCandidateStructure(query: string, candidate: AddressRecord): boolean {
  const normalizedQuery = normalizeAddressInput(query);
  const streetMatches = streetNameVariants(candidate.streetName).some((variant) => normalizedQuery.includes(variant));
  if (!streetMatches) {
    return false;
  }

  if (!normalizedQuery.includes(normalizeAddressInput(candidate.localityName))) {
    return false;
  }

  const queryState = extractQueryState(query);
  if (queryState && queryState !== candidate.stateAbbreviation) {
    return false;
  }

  const queryPostcode = extractQueryPostcode(query);
  if (queryPostcode && candidate.postcode && queryPostcode !== candidate.postcode) {
    return false;
  }

  const queryRange = extractStreetNumberRange(query, candidate.streetName);
  const candidateRange = extractStreetNumberRange(candidate.fullAddress, candidate.streetName);
  if (!queryRange || !candidateRange) {
    return false;
  }

  const querySubpremise = extractLeadingSubpremise(query);
  const candidateSubpremise = extractLeadingSubpremise(candidate.fullAddress);
  if (querySubpremise) {
    if (!candidateSubpremise) {
      return false;
    }

    if (querySubpremise.kind !== candidateSubpremise.kind || querySubpremise.value !== candidateSubpremise.value) {
      return false;
    }
  }

  return queryRange.first >= candidateRange.first && queryRange.last <= candidateRange.last;
}

function hasSubpremise(text: string): boolean {
  return SUBPREMISE_PATTERN.test(text);
}

function rankCandidates(query: string, candidates: AddressRecord[]): AddressRecord[] {
  const normalizedQuery = normalizeAddressInput(query);
  const queryHasSubpremise = hasSubpremise(query);

  return [...candidates].sort((left, right) => {
    const leftExact = normalizeAddressInput(left.fullAddress) === normalizedQuery ? 1 : 0;
    const rightExact = normalizeAddressInput(right.fullAddress) === normalizedQuery ? 1 : 0;
    if (leftExact !== rightExact) {
      return rightExact - leftExact;
    }

    const leftStructured = queryMatchesCandidateStructure(query, left) ? 1 : 0;
    const rightStructured = queryMatchesCandidateStructure(query, right) ? 1 : 0;
    if (leftStructured !== rightStructured) {
      return rightStructured - leftStructured;
    }

    if (!queryHasSubpremise) {
      const leftSubpremise = hasSubpremise(left.fullAddress) ? 1 : 0;
      const rightSubpremise = hasSubpremise(right.fullAddress) ? 1 : 0;
      if (leftSubpremise !== rightSubpremise) {
        return leftSubpremise - rightSubpremise;
      }
    }

    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }

    return left.fullAddress.localeCompare(right.fullAddress);
  });
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(latitudeB - latitudeA);
  const dLng = toRadians(longitudeB - longitudeA);
  const latA = toRadians(latitudeA);
  const latB = toRadians(latitudeB);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Opens the current SQLite database in read-only mode for API traffic and
 * status inspection.
 */
export function openReadonlyDatabase(): Database {
  return new Database(DB_PATH, { readonly: true, strict: true });
}

/**
 * Returns ranked prefix matches from the FTS search surface.
 *
 * The caller supplies free-form text; this function normalizes it into an FTS5
 * prefix query and returns a small list of candidate addresses.
 */
export function autocomplete(
  db: Database,
  query: string,
  limit = 10,
): AddressRecord[] {
  const ftsQueries = buildAddressFtsPrefixQueries(query);
  if (ftsQueries.length === 0) {
    return [];
  }

  const statement = db
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
    );

  const resultsByPid = new Map<string, AddressRecord>();
  for (const ftsQuery of ftsQueries) {
    for (const row of statement.all(ftsQuery, Math.max(limit, 25))) {
      if (!resultsByPid.has(row.addressDetailPid)) {
        resultsByPid.set(row.addressDetailPid, row);
      }
    }
  }

  return rankCandidates(query, [...resultsByPid.values()]).slice(0, limit);
}

/**
 * Resolves a user-supplied address to the best matching stored records.
 *
 * Exact normalized-address matches are preferred. If no exact match exists,
 * the function falls back to the broader autocomplete search path.
 */
export function geocode(
  db: Database,
  query: string,
  limit = 5,
): AddressRecord[] {
  const normalized = normalizeAddressInput(query);
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

  return rankCandidates(query, autocomplete(db, query, Math.max(limit, 25))).slice(0, limit);
}

/**
 * Finds the nearest known addresses to a latitude/longitude pair.
 *
 * SQLite's R-tree is used to cheaply gather nearby candidates. The final
 * ranking uses Haversine distance in the runtime so we do not need a dedicated
 * GIS extension for nearest-neighbor lookups.
 */
export function reverseGeocode(
  db: Database,
  latitude: number,
  longitude: number,
  limit = 5,
): ReverseGeocodeRecord[] {
  const candidateStatement = db.query<
    AddressRecord & { id: number },
    [number, number, number, number, number]
  >(
    `SELECT
      p.id AS id,
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
    FROM reverse_geocode_rtree r
    INNER JOIN reverse_geocode_points p ON p.id = r.id
    INNER JOIN search_addresses s ON s.address_detail_pid = p.address_detail_pid
    WHERE
      r.min_longitude >= ? AND
      r.max_longitude <= ? AND
      r.min_latitude >= ? AND
      r.max_latitude <= ?
    LIMIT ?`,
  );

  const radii = [0.0005, 0.002, 0.01, 0.05];
  const desiredCandidates = Math.max(limit * 10, 25);
  let candidates: Array<AddressRecord & { id: number }> = [];

  for (const radius of radii) {
    candidates = candidateStatement.all(
      longitude - radius,
      longitude + radius,
      latitude - radius,
      latitude + radius,
      desiredCandidates,
    );

    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates
    .filter((candidate) => candidate.latitude !== null && candidate.longitude !== null)
    .map((candidate) => ({
      addressDetailPid: candidate.addressDetailPid,
      fullAddress: candidate.fullAddress,
      streetName: candidate.streetName,
      localityName: candidate.localityName,
      stateAbbreviation: candidate.stateAbbreviation,
      postcode: candidate.postcode,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      confidence: candidate.confidence,
      geocodeTypeCode: candidate.geocodeTypeCode,
      distanceMeters: haversineDistanceMeters(latitude, longitude, candidate.latitude!, candidate.longitude!),
    }))
    .sort((left, right) => {
      if (left.distanceMeters !== right.distanceMeters) {
        return left.distanceMeters - right.distanceMeters;
      }

      return (right.confidence ?? -1) - (left.confidence ?? -1);
    })
    .slice(0, limit);
}

/**
 * Returns the database metadata table as a plain object for diagnostics and
 * health reporting.
 */
export function readDatabaseMetadata(db: Database): Record<string, string> {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM metadata ORDER BY key").all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
