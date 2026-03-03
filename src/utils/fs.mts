import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function findFileBySuffix(root: string, suffix: string): Promise<string | null> {
  const matches = await findFilesBySuffix(root, suffix);
  return matches[0] ?? null;
}

export async function findFilesBySuffix(root: string, suffix: string): Promise<string[]> {
  return findFilesByNamePattern(root, new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

export async function findFilesByNamePattern(root: string, pattern: RegExp): Promise<string[]> {
  const queue = [root];
  const matches: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && pattern.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}
