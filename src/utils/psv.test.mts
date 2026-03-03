import { describe, expect, test } from "bun:test";
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
