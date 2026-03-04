import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { DOWNLOADS_DIR, EXTRACTED_DIR, DATASET_STATE_PATH, STATE_DIR } from "../config.mts";
import { Spinner, ProgressBar } from "../terminal/progress.mts";
import { ensureDir, pathExists, readJsonFile, removePath, writeJsonFile } from "../utils/fs.mts";
import { resolveLatestDatasetResource, type DatasetResource } from "./catalog.mts";

/**
 * Persisted dataset state written to disk after a successful sync.
 */
interface DatasetState {
  current: {
    resource: DatasetResource;
    zipPath: string;
    extractDir: string;
    downloadedAt: string;
    extractedAt: string;
  } | null;
}

/**
 * Runtime description of the local dataset paths and whether a sync operation
 * performed fresh download/extraction work.
 */
export interface DatasetContext {
  resource: DatasetResource;
  zipPath: string;
  extractDir: string;
  downloaded: boolean;
  extracted: boolean;
}

/**
 * Options for dataset synchronization prior to import or serving.
 */
export interface DatasetSyncOptions {
  forceDownload?: boolean;
}

/**
 * Maps a CKAN resource to the local archive and extraction paths used by the
 * downloader/importer workflow.
 */
function getDatasetPaths(resource: DatasetResource): { zipPath: string; extractDir: string } {
  const fileName = basename(new URL(resource.url).pathname);
  return {
    zipPath: join(DOWNLOADS_DIR, `${resource.id}-${fileName}`),
    extractDir: join(EXTRACTED_DIR, resource.id),
  };
}

/**
 * Streams the remote ZIP archive to disk while updating the terminal progress
 * bar. The file is first written to a temporary path and atomically renamed
 * into place to avoid leaving a corrupt archive behind after interruptions.
 */
async function downloadDataset(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download dataset: ${response.status} ${response.statusText}`);
  }

  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : undefined;
  const progress = new ProgressBar("Downloading G-NAF", totalBytes);
  const temporaryPath = `${destinationPath}.tmp`;
  const writer = Bun.file(temporaryPath).writer();
  let downloadedBytes = 0;

  try {
    for await (const chunk of response.body) {
      downloadedBytes += chunk.byteLength;
      await writer.write(chunk);
      progress.update(downloadedBytes);
    }

    await writer.end();
    progress.finish();
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    try {
      await writer.end();
    } catch {
      // Ignore cleanup failures while handling the primary download error.
    }
    await removePath(temporaryPath);
    throw error;
  }
}

/**
 * Runs a best-effort archive extraction command and returns stderr so callers
 * can surface a useful error message if both extraction strategies fail.
 */
async function runExtractor(command: string[]): Promise<{ exitCode: number; stderr: string }> {
  try {
    const process = Bun.spawn({
      cmd: command,
      stdout: "ignore",
      stderr: "pipe",
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();
    return { exitCode, stderr };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Extracts the downloaded archive into the managed extraction directory.
 *
 * `unzip` is preferred because it is ubiquitous and fast, while `ditto` acts
 * as a macOS-friendly fallback.
 */
async function extractDataset(zipPath: string, extractDir: string): Promise<void> {
  await removePath(extractDir);
  await ensureDir(extractDir);

  const spinner = new Spinner("Extracting archive");
  spinner.start();

  let result = await runExtractor(["unzip", "-q", zipPath, "-d", extractDir]);
  if (result.exitCode !== 0) {
    await removePath(extractDir);
    await ensureDir(extractDir);
    result = await runExtractor(["ditto", "-x", "-k", zipPath, extractDir]);
  }

  if (result.exitCode !== 0) {
    spinner.stop("failed");
    throw new Error(`Archive extraction failed: ${result.stderr.trim()}`);
  }

  spinner.stop("done");
}

/**
 * Ensures the latest published G-NAF release is available on local disk.
 *
 * This handles three separate states:
 * - resource discovery via the CKAN metadata API
 * - archive download into `data/downloads`
 * - archive extraction into `data/extracted`
 *
 * The persisted dataset state is used to avoid unnecessary work on normal
 * server starts while still allowing a forced refresh.
 */
export async function syncDataset(options: DatasetSyncOptions = {}): Promise<DatasetContext> {
  const { forceDownload = false } = options;
  await ensureDir(DOWNLOADS_DIR);
  await ensureDir(EXTRACTED_DIR);
  await ensureDir(STATE_DIR);

  const resource = await resolveLatestDatasetResource();
  const datasetPaths = getDatasetPaths(resource);
  const state = (await readJsonFile<DatasetState>(DATASET_STATE_PATH)) ?? { current: null };
  const current = state.current;

  const needsDownload =
    forceDownload ||
    !current ||
    current.resource.id !== resource.id ||
    !(await pathExists(datasetPaths.zipPath));

  const needsExtract =
    needsDownload ||
    !current ||
    current.resource.id !== resource.id ||
    !(await pathExists(datasetPaths.extractDir));

  if (needsDownload) {
    await removePath(datasetPaths.zipPath);
    await downloadDataset(resource.url, datasetPaths.zipPath);
  }

  if (needsExtract) {
    await extractDataset(datasetPaths.zipPath, datasetPaths.extractDir);
  }

  await writeJsonFile(DATASET_STATE_PATH, {
    current: {
      resource,
      zipPath: datasetPaths.zipPath,
      extractDir: datasetPaths.extractDir,
      downloadedAt: current?.resource.id === resource.id && !needsDownload ? current.downloadedAt : new Date().toISOString(),
      extractedAt: current?.resource.id === resource.id && !needsExtract ? current.extractedAt : new Date().toISOString(),
    },
  } satisfies DatasetState);

  return {
    resource,
    zipPath: datasetPaths.zipPath,
    extractDir: datasetPaths.extractDir,
    downloaded: needsDownload,
    extracted: needsExtract,
  };
}

/**
 * Reads the persisted dataset state used by `status` and by future sync runs.
 */
export async function readDatasetState(): Promise<DatasetState | null> {
  return readJsonFile<DatasetState>(DATASET_STATE_PATH);
}
