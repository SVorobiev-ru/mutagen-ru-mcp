import { describe, expect, it } from "vitest";
import { estimatePlan, formatRub } from "../../../src/budget/estimate.js";
import { canonicalJson, requestHash } from "../../../src/budget/hash.js";
import {
  DEFAULT_PRICES,
  isPriceKey,
  parsePriceOverrides,
  resolvePrices,
  toKopecks,
} from "../../../src/budget/pricing.js";
import { MutagenError } from "../../../src/core/errors.js";
import { PARSER_TYPES } from "../../../src/core/types.js";

describe("pricing", () => {
  it("has the documented prices", () => {
    expect(DEFAULT_PRICES["check_key.new"]).toMatchObject({
      rub: 0.3,
      confirmed: true,
      freeRepeatDays: 7,
    });
    for (const parser of PARSER_TYPES) {
      expect(DEFAULT_PRICES[`parser.${parser}`]).toMatchObject({
        rub: parser === "wordstat_key" ? 0.2 : 0.02,
        confirmed: true,
        verifiedAt: "2026-10-14",
        source: "live calibration",
      });
    }
    expect(DEFAULT_PRICES["check_key.new"].source).toBe("live calibration");
    expect(DEFAULT_PRICES["suggest.new"]).toMatchObject({ rub: 0, confirmed: false });
    expect(isPriceKey("progects")).toBe(false);
    expect(DEFAULT_PRICES["serp.report"]).toMatchObject({
      rub: 0,
      requiresSubscription: true,
      quotaRequests: 1,
    });
    expect(DEFAULT_PRICES.balance.rub).toBe(0);
    expect(isPriceKey("parser.direct")).toBe(true);
    expect(isPriceKey("parser.nope")).toBe(false);
  });

  it("applies overrides as confirmed", () => {
    const table = resolvePrices({ "parser.direct": 0.05, "check_key.new": { rub: 0.25 } });
    expect(table["parser.direct"]).toMatchObject({
      rub: 0.05,
      confirmed: true,
      source: "override",
    });
    expect(table["check_key.new"]).toMatchObject({ rub: 0.25, freeRepeatDays: 7 });
    expect(DEFAULT_PRICES["parser.direct"].rub).toBe(0.02);
  });

  it("rejects unknown keys and fractional kopecks", () => {
    expect(() => resolvePrices({ nope: 1 } as never)).toThrow(MutagenError);
    expect(() => resolvePrices({ "parser.direct": 0.025 })).toThrow(/kopecks/);
    expect(() => toKopecks(-1)).toThrow(/non-negative/);
    expect(toKopecks(0.3)).toBe(30);
  });

  it("parses MUTAGEN_PRICES_JSON", () => {
    expect(parsePriceOverrides('{"parser.direct":0.04}')).toEqual({ "parser.direct": 0.04 });
    expect(() => parsePriceOverrides("{")).toThrow(/JSON/);
    expect(() => parsePriceOverrides("[1]")).toThrow(/object/);
    expect(() => parsePriceOverrides('{"parser.direct":"x"}')).toThrow(/rub/);
    expect(() => parsePriceOverrides('{"x":1}')).toThrow(/unknown/);
  });
});

describe("estimatePlan", () => {
  it("counts in whole kopecks", () => {
    const estimate = estimatePlan([
      {
        method: "parser.mass.new",
        parsers: ["wordstat_n", "wordstat_q", "wordstat_qs"],
        phrases: 1000,
      },
    ]);
    expect(estimate.totalRub).toBe(60);
    expect(estimate.totalKopecks).toBe(6000);
    expect(estimate.items).toHaveLength(3);
    expect(estimate.items[0]).toMatchObject({ parser: "wordstat_n", kopecks: 2000, rub: 20 });
    expect(estimate.unconfirmedPrices).toBe(false);
  });

  it("avoids float drift on small sums", () => {
    const estimate = estimatePlan([
      { method: "parser.get", parsers: ["wordstat_n"], phrases: 3 },
      { method: "check_key.new", phrases: 1 },
    ]);
    expect(estimate.totalRub).toBe(0.36);
    expect(formatRub(estimate.totalKopecks)).toBe("0.36");
  });

  it("skips free repeats of check_key and pending parser.get phrases, one payment per phrase", () => {
    const estimate = estimatePlan([
      { method: "check_key.new", phrases: 10, repeatPhrases: 4 },
      { method: "parser.get", parsers: ["direct", "wordstat_key"], phrases: 3, pendingPhrases: 1 },
    ]);
    expect(estimate.items[0]).toMatchObject({ units: 10, billableUnits: 6, kopecks: 180 });
    expect(estimate.items[1]).toMatchObject({ units: 3, billableUnits: 2, kopecks: 4 });
    expect(estimate.items[2]).toMatchObject({ billableUnits: 2, kopecks: 40, confirmed: true });
    expect(estimate.totalRub).toBe(2.24);
    expect(estimate.unconfirmedPrices).toBe(false);
    expect(() =>
      estimatePlan([{ method: "parser.get", parsers: ["direct"], phrases: 1, pendingPhrases: 2 }]),
    ).toThrow(/pendingPhrases/);
  });

  it("reports subscription quota for serp.report and free methods", () => {
    const estimate = estimatePlan([
      { method: "serp.report", requests: 3 },
      { method: "parser.mass.list" },
    ]);
    expect(estimate).toMatchObject({
      totalRub: 0,
      quotaRequests: 3,
      requiresSubscription: true,
    });
    expect(estimatePlan([]).totalRub).toBe(0);
  });

  it("uses custom prices and validates input", () => {
    const prices = resolvePrices({ "parser.wordstat_n": 0.03 });
    expect(
      estimatePlan([{ method: "parser.mass.new", parsers: ["wordstat_n"], phrases: 3 }], prices)
        .totalRub,
    ).toBe(0.09);
    expect(() => estimatePlan([{ method: "check_key.new", phrases: 1, repeatPhrases: 2 }])).toThrow(
      MutagenError,
    );
    expect(() => estimatePlan([{ method: "check_key.new", phrases: -1 }])).toThrow(/non-negative/);
    expect(() =>
      estimatePlan([{ method: "parser.get", parsers: ["bogus" as never], phrases: 1 }]),
    ).toThrow(/parser/);
  });
});

describe("requestHash", () => {
  it("is stable regardless of key order and ignores undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, b: 3 }] })).toBe(
      '{"a":[{"b":3,"d":2}],"b":1}',
    );
    expect(requestHash("m", { a: 1, b: 2 })).toBe(requestHash("m", { b: 2, a: 1 }));
    expect(requestHash("m", { a: 1 })).not.toBe(requestHash("n", { a: 1 }));
    expect(requestHash("m")).toMatch(/^[a-f0-9]{64}$/);
  });
});
