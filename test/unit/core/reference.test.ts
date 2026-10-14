import { describe, expect, it } from "vitest";
import {
  isSerpRegion,
  isWordstatRegionId,
  SERP_REGION_IDS,
  SERP_REGIONS,
  WORDSTAT_REGIONS,
} from "../../../src/core/regions.js";
import {
  isReportName,
  REPORT_NAMES,
  REPORTS,
  reportInfo,
  YANDEX_RU_COLUMNS,
} from "../../../src/core/reports.js";
import { FREQUENCY_PARSERS, isParserType, PARSER_TYPES } from "../../../src/core/types.js";

describe("reports catalog", () => {
  it("lists 23 documented reports plus report_keyword_questions", () => {
    expect(REPORT_NAMES).toHaveLength(24);
    expect(isReportName("report_keyword_questions")).toBe(true);
    expect(isReportName("report_nope")).toBe(false);
    expect(isReportName("toString")).toBe(false);
  });

  it("has titles, objects and columns for every report", () => {
    for (const name of REPORT_NAMES) {
      const info = reportInfo(name);
      expect(info.titleRu).toMatch(/[а-яё]/i);
      expect(info.titleEn).toMatch(/[a-z]/i);
      expect(info.objects.length).toBeGreaterThan(0);
      expect(info.columns.length).toBeGreaterThan(0);
      expect(new Set(info.columns).size).toBe(info.columns.length);
    }
  });

  it("matches the documented objects", () => {
    expect(REPORTS.report_keyword_info.objects).toEqual(["keyword", "keywords"]);
    expect(REPORTS.report_keyword_tailings.objects).toEqual(["keyword"]);
    expect(REPORTS.report_keywords_organic.objects).toEqual([
      "domain",
      "domain_with_subdomains",
      "page",
    ]);
    expect(REPORTS.report_keywords_ppc.objects).toEqual(["domain", "domain_with_subdomains"]);
    expect(REPORTS.report_page_recommended_keywords.objects).toEqual(["page"]);
  });

  it("marks the four yandex_ru reports", () => {
    const yandexRu = REPORT_NAMES.filter((name) => REPORTS[name].yandexRu).sort();
    expect(yandexRu).toEqual([
      "report_keyword_info",
      "report_keyword_questions",
      "report_keyword_tailings",
      "report_keyword_variations",
    ]);
    expect(YANDEX_RU_COLUMNS).toHaveLength(6);
  });

  it("includes the Direct forecast columns for keyword statistics", () => {
    const columns = REPORTS.report_keyword_info.columns;
    expect(columns).toHaveLength(38);
    expect(columns).toContain("first_premium_budget_bid");
    expect(columns).toContain("std_ctr");
  });
});

describe("regions", () => {
  it("lists the nine Mega-tool regions", () => {
    expect(SERP_REGIONS).toHaveLength(9);
    expect(SERP_REGION_IDS).toContain("yandex_kazan");
    expect(isSerpRegion("yandex_msk")).toBe(true);
    expect(isSerpRegion("yandex_tver")).toBe(false);
    expect(isSerpRegion(1)).toBe(false);
  });

  it("lists common Wordstat regions", () => {
    expect(WORDSTAT_REGIONS.map((region) => region.id)).toEqual(["0", "225", "213", "2"]);
  });

  it.each([
    ["0", true],
    ["225", true],
    ["255,-17", true],
    ["213,2", true],
    ["", false],
    ["225, 213", false],
    ["msk", false],
    ["225,", false],
  ])("validates region id %j", (value, valid) => {
    expect(isWordstatRegionId(value)).toBe(valid);
  });
});

describe("parser types", () => {
  it("lists nine parsers, six of them frequency parsers", () => {
    expect(PARSER_TYPES).toHaveLength(9);
    expect(FREQUENCY_PARSERS).toHaveLength(6);
    expect(isParserType("wordstat_key_50")).toBe(true);
    expect(isParserType("wordstat")).toBe(false);
  });
});
