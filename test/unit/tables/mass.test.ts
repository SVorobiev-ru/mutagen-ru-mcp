import { describe, expect, it } from "vitest";
import {
  flatten,
  frequencyOf,
  normalizeMassData,
  phraseKey,
  toNumber,
} from "../../../src/tables/mass.js";

describe("normalizeMassData", () => {
  it("reads an object keyed by phrase", () => {
    expect(normalizeMassData({ окна: 120, двери: { frequency: "7" } })).toEqual({
      recognized: true,
      entries: [
        { phrase: "окна", value: 120 },
        { phrase: "двери", value: { frequency: "7" } },
      ],
    });
  });

  it("reads arrays with key, keyword or phrase fields", () => {
    const data = normalizeMassData([
      { key: "a", frequency: 1 },
      { keyword: "b", frequency: 2 },
      { phrase: "c", data: { frequency: 3 } },
      { key: "d", data: 4 },
    ]);
    expect(data).toEqual({
      recognized: true,
      entries: [
        { phrase: "a", value: { frequency: 1 } },
        { phrase: "b", value: { frequency: 2 } },
        { phrase: "c", value: { frequency: 3 } },
        { phrase: "d", value: 4 },
      ],
    });
  });

  it("unwraps nested containers and PHP-style numbered objects", () => {
    expect(normalizeMassData({ data: { "0": { key: "a", frequency: 1 } } })).toEqual({
      recognized: true,
      entries: [{ phrase: "a", value: { frequency: 1 } }],
    });
    expect(normalizeMassData({ result: { items: [{ key: "x", wordstat_n: 9 }] } })).toEqual({
      recognized: true,
      entries: [{ phrase: "x", value: { wordstat_n: 9 } }],
    });
    expect(normalizeMassData({ окна: { data: { frequency: 5 }, status: "ok" } })).toEqual({
      recognized: true,
      entries: [{ phrase: "окна", value: { status: "ok", frequency: 5 } }],
    });
  });

  it("treats missing data as empty and rejects unknown shapes", () => {
    expect(normalizeMassData(undefined)).toEqual({ recognized: true, entries: [] });
    expect(normalizeMassData({})).toEqual({ recognized: true, entries: [] });
    expect(normalizeMassData([1, 2])).toEqual({ recognized: false });
    expect(normalizeMassData([{ frequency: 1 }])).toEqual({ recognized: false });
    expect(normalizeMassData({ a: [1, 2] })).toEqual({ recognized: false });
    expect(normalizeMassData("text")).toEqual({ recognized: false });
    expect(normalizeMassData({ data: { data: { data: { data: { a: 1 } } } } })).toEqual({
      recognized: false,
    });
  });
});

describe("mass value helpers", () => {
  it("finds the frequency in several shapes", () => {
    expect(frequencyOf(5, "wordstat_n")).toBe(5);
    expect(frequencyOf("12", "wordstat_n")).toBe(12);
    expect(frequencyOf({ frequency: "3,5" }, "wordstat_n")).toBe(3.5);
    expect(frequencyOf({ wordstat_q: 8 }, "wordstat_q")).toBe(8);
    expect(frequencyOf({ count: 4, name: "x" }, "wordstat_n")).toBe(4);
    expect(frequencyOf({ a: 1, b: 2 }, "wordstat_n")).toBeNull();
    expect(frequencyOf(null, "wordstat_n")).toBeNull();
  });

  it("converts numbers and flattens nested values", () => {
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(flatten({ a: { b: 1, c: [1, 2] }, d: "x" })).toEqual({ a_b: 1, a_c: "[1,2]", d: "x" });
    expect(flatten(7, "wordstat_n")).toEqual({ wordstat_n: 7 });
    expect(flatten([1])).toEqual({ value: "[1]" });
    expect(phraseKey("  Окна   ПВХ ")).toBe("окна пвх");
  });
});
