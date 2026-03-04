import { join } from "node:path";

const cwd = process.cwd();

export const APP_NAME = "gnafkit";
export const GNAF_PACKAGE_ID = "19432f89-dc3a-4ef3-b943-5326ef1dbecc";
export const DATA_DIR = join(cwd, "data");
export const DOWNLOADS_DIR = join(DATA_DIR, "downloads");
export const EXTRACTED_DIR = join(DATA_DIR, "extracted");
export const STATE_DIR = join(DATA_DIR, "state");
export const SQLITE_DIR = join(DATA_DIR, "sqlite");
export const DB_PATH = join(SQLITE_DIR, "gnaf.sqlite");
export const DATASET_STATE_PATH = join(STATE_DIR, "dataset.json");
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const IMPORT_BATCH_SIZE = 5_000;
export const SCHEMA_VERSION = 2;

export const PSV_FILE_PATTERNS = {
  state: /^[A-Z]{2,3}_STATE_psv\.psv$/,
  locality: /^[A-Z]{2,3}_LOCALITY_psv\.psv$/,
  streetLocality: /^[A-Z]{2,3}_STREET_LOCALITY_psv\.psv$/,
  addressDetail: /^[A-Z]{2,3}_ADDRESS_DETAIL_psv\.psv$/,
  addressDefaultGeocode: /^[A-Z]{2,3}_ADDRESS_DEFAULT_GEOCODE_psv\.psv$/,
} as const;
