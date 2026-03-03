const nonAlphaNumericPattern = /[^a-z0-9]+/g;
const repeatedWhitespacePattern = /\s+/g;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(nonAlphaNumericPattern, " ")
    .replace(repeatedWhitespacePattern, " ")
    .trim();
}

export function compactWhitespace(value: string): string {
  return value.replace(repeatedWhitespacePattern, " ").trim();
}

export function joinNonEmpty(parts: Array<string | null | undefined>, separator = " "): string {
  return compactWhitespace(parts.filter((part) => part && part.trim().length > 0).join(separator));
}

export function escapeFtsToken(value: string): string {
  return value.replace(/"/g, "\"\"");
}

export function buildFtsPrefixQuery(value: string): string {
  const tokens = normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => `"${escapeFtsToken(token)}"*`);

  return tokens.join(" ");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
