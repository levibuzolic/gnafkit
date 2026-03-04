import { GNAF_PACKAGE_ID } from "../config.mts";

/**
 * Minimal metadata for the currently selected downloadable G-NAF release.
 */
export interface DatasetResource {
  id: string;
  name: string;
  url: string;
  created: string | null;
  lastModified: string | null;
}

/**
 * Shape of the CKAN `package_show` response used to resolve the latest G-NAF
 * ZIP resource from `data.gov.au`.
 */
interface CkanResponse {
  success: boolean;
  result: {
    resources: Array<{
      id: string;
      name: string;
      format?: string | null;
      url: string;
      created?: string | null;
      last_modified?: string | null;
    }>;
  };
}

/**
 * Resolves the newest public G-NAF GDA2020 ZIP from the official CKAN package
 * metadata on `data.gov.au`.
 *
 * The implementation intentionally discovers the active resource at runtime
 * rather than baking a release URL into the codebase, so `sync` can track new
 * quarterly releases without requiring a code change.
 */
export async function resolveLatestDatasetResource(): Promise<DatasetResource> {
  const response = await fetch(
    `https://data.gov.au/data/api/3/action/package_show?id=${encodeURIComponent(GNAF_PACKAGE_ID)}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve G-NAF metadata: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as CkanResponse;
  if (!payload.success) {
    throw new Error("G-NAF metadata endpoint reported failure");
  }

  const candidates = payload.result.resources
    .filter((resource) => (resource.format ?? "").toUpperCase() === "ZIP")
    .filter((resource) => resource.name.toUpperCase().includes("GDA2020"))
    .sort((left, right) => {
      const leftTimestamp = Date.parse(left.last_modified ?? left.created ?? "1970-01-01");
      const rightTimestamp = Date.parse(right.last_modified ?? right.created ?? "1970-01-01");
      return rightTimestamp - leftTimestamp;
    });

  const latest = candidates[0];
  if (!latest) {
    throw new Error("Unable to find a GDA2020 ZIP resource in the G-NAF metadata");
  }

  return {
    id: latest.id,
    name: latest.name,
    url: latest.url,
    created: latest.created ?? null,
    lastModified: latest.last_modified ?? null,
  };
}
