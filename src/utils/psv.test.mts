import { describe, expect, test } from "bun:test";
import { buildAddressFtsPrefixQueries, normalizeAddressInput } from "../gnaf/address-aliases.mts";
import { normalizeSearchText } from "./strings.mts";
import { parsePsvLine } from "./psv.mts";

describe("parsePsvLine", () => {
  test("parses plain values", () => {
    expect(parsePsvLine("A|B|C")).toEqual(["A", "B", "C"]);
  });

  test("parses quoted separators", () => {
    expect(parsePsvLine("\"12|14\"|MELBOURNE|3000")).toEqual(["12|14", "MELBOURNE", "3000"]);
  });

  test("parses escaped quotes", () => {
    expect(parsePsvLine("\"THE \"\"GEORGE\"\"\"|SYDNEY")).toEqual(["THE \"GEORGE\"", "SYDNEY"]);
  });
});

describe("normalizeSearchText", () => {
  test("normalizes punctuation and casing", () => {
    expect(normalizeSearchText("12/1 Collins St., Melbourne VIC 3000")).toBe("12 1 collins st melbourne vic 3000");
  });
});

describe("normalizeAddressInput", () => {
  test("normalizes common Australian unit synonyms", () => {
    expect(normalizeAddressInput("Apt 12/120 Collins St Melbourne VIC 3000")).toContain("unit 12 120 collins st melbourne vic 3000");
  });
});

describe("buildAddressFtsPrefixQueries", () => {
  test("builds alternate queries for common street abbreviations", () => {
    const queries = buildAddressFtsPrefixQueries("120 Collins St Melbourne");
    expect(queries.some((query) => query.includes("\"st\"*"))).toBe(true);
    expect(queries.some((query) => query.includes("\"street\"*"))).toBe(true);
  });
});
