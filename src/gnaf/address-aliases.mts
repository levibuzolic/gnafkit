import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASET_STATE_PATH } from "../config.mts";
import { parsePsvLine } from "../utils/psv.mts";
import { compactWhitespace, escapeFtsToken, normalizeSearchText } from "../utils/strings.mts";

/**
 * Narrow view of the persisted dataset state needed to locate the extracted
 * G-NAF authority-code reference files.
 */
interface DatasetState {
  current: {
    extractDir: string;
  } | null;
}

/**
 * Row shape used by the authority-code PSV reference files.
 */
interface AuthorityRow {
  CODE: string;
  NAME: string;
  DESCRIPTION: string;
}

/**
 * Cached authority-code lookup tables used to normalize Australian address
 * variants at query time.
 */
interface AddressAliasData {
  tokenAlternatives: Map<string, string[]>;
  canonicalByToken: Map<string, string>;
  streetTypeAbbreviationByFull: Map<string, string>;
  streetSuffixAbbreviationByFull: Map<string, string>;
  unitLikeTokens: Set<string>;
  levelLikeTokens: Set<string>;
}

const unitLikeTokens = [
  "a",
  "apartment",
  "apt",
  "f",
  "flat",
  "se",
  "ste",
  "suite",
  "strata",
  "u",
  "unit",
];

const levelLikeTokens = [
  "fl",
  "flr",
  "floor",
  "level",
  "lvl",
  "lv",
];

const defaultStreetTypePairs = [
  ["alley", "ally"],
  ["arcade", "arc"],
  ["avenue", "ave"],
  ["boulevard", "bvd"],
  ["close", "cl"],
  ["court", "ct"],
  ["crescent", "cres"],
  ["drive", "dr"],
  ["grove", "gr"],
  ["highway", "hwy"],
  ["lane", "ln"],
  ["parade", "pde"],
  ["place", "pl"],
  ["road", "rd"],
  ["square", "sq"],
  ["street", "st"],
  ["terrace", "tce"],
] as const;

const defaultStreetSuffixPairs = [
  ["east", "e"],
  ["north", "n"],
  ["north east", "ne"],
  ["north west", "nw"],
  ["south", "s"],
  ["south east", "se"],
  ["south west", "sw"],
  ["west", "w"],
] as const;

let cachedExtractDir: string | null = null;
let cachedAliasData: AddressAliasData | null = null;

function findFirstFileByPattern(root: string, pattern: RegExp): string | null {
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && pattern.test(entry.name)) {
        return fullPath;
      }
    }
  }

  return null;
}

function readAuthorityRows(path: string): AuthorityRow[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parsePsvLine(lines[0] ?? "");

  return lines.slice(1).map((line) => {
    const values = parsePsvLine(line);
    const row: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]!] = values[index] ?? "";
    }

    return row as unknown as AuthorityRow;
  });
}

function addAlternative(map: Map<string, Set<string>>, token: string, alternative: string): void {
  const normalizedToken = normalizeSearchText(token);
  const normalizedAlternative = normalizeSearchText(alternative);
  if (!normalizedToken || !normalizedAlternative) {
    return;
  }

  if (!map.has(normalizedToken)) {
    map.set(normalizedToken, new Set<string>([normalizedToken]));
  }

  map.get(normalizedToken)!.add(normalizedAlternative);
}

function seedDefaultAlternatives(
  alternatives: Map<string, Set<string>>,
  canonicalByToken: Map<string, string>,
  streetTypeAbbreviationByFull: Map<string, string>,
  streetSuffixAbbreviationByFull: Map<string, string>,
): void {
  for (const [full, abbreviation] of defaultStreetTypePairs) {
    addAlternative(alternatives, full, abbreviation);
    addAlternative(alternatives, abbreviation, full);
    canonicalByToken.set(abbreviation, full);
    streetTypeAbbreviationByFull.set(full, abbreviation);
  }

  for (const [full, abbreviation] of defaultStreetSuffixPairs) {
    addAlternative(alternatives, full, abbreviation);
    addAlternative(alternatives, abbreviation, full);
    canonicalByToken.set(abbreviation, full);
    streetSuffixAbbreviationByFull.set(full, abbreviation);
  }
}

function buildAddressAliasData(extractDir: string): AddressAliasData {
  const flatTypesPath = findFirstFileByPattern(extractDir, /^Authority_Code_FLAT_TYPE_AUT_psv\.psv$/);
  const levelTypesPath = findFirstFileByPattern(extractDir, /^Authority_Code_LEVEL_TYPE_AUT_psv\.psv$/);
  const streetTypesPath = findFirstFileByPattern(extractDir, /^Authority_Code_STREET_TYPE_AUT_psv\.psv$/);
  const streetSuffixesPath = findFirstFileByPattern(extractDir, /^Authority_Code_STREET_SUFFIX_AUT_psv\.psv$/);

  if (!flatTypesPath || !levelTypesPath || !streetTypesPath || !streetSuffixesPath) {
    throw new Error("Unable to locate the required authority-code PSV files");
  }

  const alternatives = new Map<string, Set<string>>();
  const canonicalByToken = new Map<string, string>();
  const streetTypeAbbreviationByFull = new Map<string, string>();
  const streetSuffixAbbreviationByFull = new Map<string, string>();

  seedDefaultAlternatives(
    alternatives,
    canonicalByToken,
    streetTypeAbbreviationByFull,
    streetSuffixAbbreviationByFull,
  );

  for (const row of readAuthorityRows(streetTypesPath)) {
    const full = normalizeSearchText(row.CODE);
    const abbreviation = normalizeSearchText(row.NAME);
    addAlternative(alternatives, full, abbreviation);
    addAlternative(alternatives, abbreviation, full);
    if (full && abbreviation) {
      canonicalByToken.set(abbreviation, full);
      streetTypeAbbreviationByFull.set(full, abbreviation);
    }
  }

  for (const row of readAuthorityRows(streetSuffixesPath)) {
    const full = normalizeSearchText(row.NAME);
    const abbreviation = normalizeSearchText(row.CODE);
    addAlternative(alternatives, full, abbreviation);
    addAlternative(alternatives, abbreviation, full);
    if (full && abbreviation) {
      canonicalByToken.set(abbreviation, full);
      streetSuffixAbbreviationByFull.set(full, abbreviation);
    }
  }

  for (const row of readAuthorityRows(flatTypesPath)) {
    addAlternative(alternatives, row.CODE, row.NAME);
    addAlternative(alternatives, row.NAME, row.CODE);
  }

  for (const row of readAuthorityRows(levelTypesPath)) {
    addAlternative(alternatives, row.CODE, row.NAME);
    addAlternative(alternatives, row.NAME, row.CODE);
  }

  return {
    tokenAlternatives: new Map(
      [...alternatives.entries()].map(([token, values]) => [token, [...values].sort((left, right) => left.localeCompare(right))]),
    ),
    canonicalByToken,
    streetTypeAbbreviationByFull,
    streetSuffixAbbreviationByFull,
    unitLikeTokens: new Set(unitLikeTokens),
    levelLikeTokens: new Set(levelLikeTokens),
  };
}

function getCurrentExtractDir(): string | null {
  try {
    const state = JSON.parse(readFileSync(DATASET_STATE_PATH, "utf8")) as DatasetState;
    return state.current?.extractDir ?? null;
  } catch {
    return null;
  }
}

function getAliasData(): AddressAliasData {
  const extractDir = getCurrentExtractDir();
  if (!extractDir) {
    const alternatives = new Map<string, Set<string>>();
    const canonicalByToken = new Map<string, string>();
    const streetTypeAbbreviationByFull = new Map<string, string>();
    const streetSuffixAbbreviationByFull = new Map<string, string>();

    seedDefaultAlternatives(
      alternatives,
      canonicalByToken,
      streetTypeAbbreviationByFull,
      streetSuffixAbbreviationByFull,
    );

    return {
      tokenAlternatives: new Map(
        [...alternatives.entries()].map(([token, values]) => [token, [...values].sort((left, right) => left.localeCompare(right))]),
      ),
      canonicalByToken,
      streetTypeAbbreviationByFull,
      streetSuffixAbbreviationByFull,
      unitLikeTokens: new Set(unitLikeTokens),
      levelLikeTokens: new Set(levelLikeTokens),
    };
  }

  if (cachedAliasData && cachedExtractDir === extractDir) {
    return cachedAliasData;
  }

  cachedExtractDir = extractDir;
  cachedAliasData = buildAddressAliasData(extractDir);
  return cachedAliasData;
}

function maybeCanonicalizeLeadingToken(token: string, nextToken: string | undefined, aliases: AddressAliasData): string {
  if (aliases.unitLikeTokens.has(token) && nextToken && /^[a-z0-9]+$/i.test(nextToken)) {
    return "unit";
  }

  if (aliases.levelLikeTokens.has(token) && nextToken && /^[a-z0-9]+$/i.test(nextToken)) {
    return "level";
  }

  return token;
}

export function normalizeAddressInput(value: string): string {
  const aliases = getAliasData();
  const normalized = normalizeSearchText(value).replace(/\bstrata unit\b/g, "unit");
  if (!normalized) {
    return "";
  }

  const sourceTokens = normalized.split(" ");
  const targetTokens: string[] = [];

  for (let index = 0; index < sourceTokens.length; index += 1) {
    const token = sourceTokens[index]!;
    const nextToken = sourceTokens[index + 1];
    targetTokens.push(maybeCanonicalizeLeadingToken(token, nextToken, aliases));
  }

  return compactWhitespace(targetTokens.join(" "));
}

function buildPrefixQueryFromTokens(tokens: string[]): string {
  return tokens
    .filter(Boolean)
    .map((token) => `"${escapeFtsToken(token)}"*`)
    .join(" ");
}

export function buildAddressFtsPrefixQueries(value: string): string[] {
  const aliases = getAliasData();
  const rawNormalized = normalizeSearchText(value).replace(/\bstrata unit\b/g, "unit");
  if (!rawNormalized) {
    return [];
  }

  const rawTokens = rawNormalized.split(" ").filter(Boolean);
  const canonicalTokens = rawTokens.map((token, index, tokens) => {
    const canonicalToken = maybeCanonicalizeLeadingToken(token, tokens[index + 1], aliases);
    return aliases.canonicalByToken.get(canonicalToken) ?? canonicalToken;
  });

  const flatCanonicalTokens = [...canonicalTokens];
  if (flatCanonicalTokens.length >= 2 && maybeCanonicalizeLeadingToken(rawTokens[0]!, rawTokens[1], aliases) === "unit") {
    flatCanonicalTokens[0] = "flat";
  }

  return [
    buildPrefixQueryFromTokens(rawTokens),
    buildPrefixQueryFromTokens(canonicalTokens),
    buildPrefixQueryFromTokens(flatCanonicalTokens),
  ].filter((query, index, queries) => query.length > 0 && queries.indexOf(query) === index);
}

export function streetNameVariants(streetName: string): string[] {
  const aliases = getAliasData();
  const normalized = normalizeAddressInput(streetName);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);
  const tokens = normalized.split(" ");

  const lastToken = tokens[tokens.length - 1];
  if (lastToken) {
    const abbreviation = aliases.streetTypeAbbreviationByFull.get(lastToken);
    if (abbreviation) {
      variants.add(compactWhitespace([...tokens.slice(0, -1), abbreviation].join(" ")));
    }
  }

  const trailingTwo = tokens.slice(-2).join(" ");
  if (trailingTwo) {
    const suffixAbbreviation = aliases.streetSuffixAbbreviationByFull.get(trailingTwo);
    if (suffixAbbreviation) {
      variants.add(compactWhitespace([...tokens.slice(0, -2), suffixAbbreviation].join(" ")));
    }
  }

  return [...variants];
}

export function extractLeadingSubpremise(text: string): { kind: "unit" | "level" | "lot"; value: string } | null {
  const normalized = normalizeAddressInput(text);
  const tokens = normalized.split(" ");
  if (tokens.length < 2) {
    return null;
  }

  const [kind, value] = tokens;
  if (!kind || !value) {
    return null;
  }

  if ((kind === "unit" || kind === "level" || kind === "lot") && /^[a-z0-9]+$/i.test(value)) {
    return { kind, value };
  }

  return null;
}
