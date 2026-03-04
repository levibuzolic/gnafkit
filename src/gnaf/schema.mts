export const RAW_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = OFF;

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE states (
  state_pid TEXT PRIMARY KEY,
  state_name TEXT NOT NULL,
  state_abbreviation TEXT NOT NULL
);

CREATE TABLE localities (
  locality_pid TEXT PRIMARY KEY,
  locality_name TEXT NOT NULL,
  primary_postcode TEXT,
  state_pid TEXT NOT NULL
);

CREATE TABLE streets (
  street_locality_pid TEXT PRIMARY KEY,
  street_name TEXT NOT NULL,
  street_type_code TEXT,
  street_suffix_code TEXT,
  locality_pid TEXT NOT NULL,
  state_pid TEXT,
  full_street_name TEXT NOT NULL
);

CREATE TABLE addresses (
  address_detail_pid TEXT PRIMARY KEY,
  building_name TEXT,
  lot_number TEXT,
  flat_number TEXT,
  level_number TEXT,
  number_first TEXT,
  number_last TEXT,
  street_locality_pid TEXT NOT NULL,
  locality_pid TEXT NOT NULL,
  postcode TEXT,
  confidence INTEGER,
  alias_principal TEXT,
  address_site_name TEXT
);

CREATE TABLE geocodes (
  address_detail_pid TEXT PRIMARY KEY,
  latitude REAL,
  longitude REAL,
  geocode_type_code TEXT
);

CREATE TABLE search_addresses (
  address_detail_pid TEXT PRIMARY KEY,
  full_address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  street_name TEXT NOT NULL,
  locality_name TEXT NOT NULL,
  state_abbreviation TEXT NOT NULL,
  postcode TEXT,
  latitude REAL,
  longitude REAL,
  confidence INTEGER,
  geocode_type_code TEXT
);

CREATE TABLE reverse_geocode_points (
  id INTEGER PRIMARY KEY,
  address_detail_pid TEXT NOT NULL UNIQUE
);

CREATE VIRTUAL TABLE reverse_geocode_rtree USING rtree(
  id,
  min_longitude,
  max_longitude,
  min_latitude,
  max_latitude
);

CREATE VIRTUAL TABLE search_fts USING fts5(
  address_detail_pid UNINDEXED,
  full_address,
  street_name,
  locality_name,
  postcode,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export const INDEX_SQL = `
CREATE INDEX idx_localities_state_pid ON localities(state_pid);
CREATE INDEX idx_streets_locality_pid ON streets(locality_pid);
CREATE INDEX idx_addresses_street_locality_pid ON addresses(street_locality_pid);
CREATE INDEX idx_addresses_locality_pid ON addresses(locality_pid);
CREATE INDEX idx_addresses_postcode ON addresses(postcode);
CREATE INDEX idx_search_addresses_normalized ON search_addresses(normalized_address);
CREATE INDEX idx_search_addresses_locality ON search_addresses(locality_name);
CREATE INDEX idx_search_addresses_postcode ON search_addresses(postcode);
`;
