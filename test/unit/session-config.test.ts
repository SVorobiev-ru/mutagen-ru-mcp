import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { MutagenError } from "../../src/core/errors.js";
import { API_KEY } from "./core/helpers.js";

const linux = { platform: "linux" as const, homedir: "/home/u" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({}, linux);
    expect(config).toEqual({
      baseUrl: "http://api.mutagen.ru/json",
      budgetRub: 50,
      autoApproveRub: 1,
      freeOnly: false,
      cacheDir: "/home/u/.cache/mutagen-ru-mcp",
      cacheTtlDays: { frequency: 7, competition: 7, report: 1 },
      noCache: false,
      stateDir: "/home/u/.local/state/mutagen-ru-mcp",
      prices: {},
      concurrency: 2,
      rps: 3,
    });
    expect(config.apiKey).toBeUndefined();
  });

  it("reads every variable", () => {
    const config = loadConfig(
      {
        MUTAGEN_API_KEY: ` ${API_KEY} `,
        MUTAGEN_BASE_URL: "https://api.example.test/json",
        MUTAGEN_BUDGET_RUB: "12,5",
        MUTAGEN_AUTO_APPROVE_RUB: "0",
        MUTAGEN_FREE_ONLY: "1",
        MUTAGEN_CACHE_DIR: "/c",
        MUTAGEN_CACHE_TTL_FREQUENCY_DAYS: "3",
        MUTAGEN_CACHE_TTL_COMPETITION_DAYS: "2",
        MUTAGEN_CACHE_TTL_REPORT_DAYS: "0.5",
        MUTAGEN_NO_CACHE: "true",
        MUTAGEN_STATE_DIR: "/s",
        MUTAGEN_PRICES_JSON: '{"parser.direct":0.05}',
        MUTAGEN_CONCURRENCY: "4",
        MUTAGEN_RPS: "5",
      },
      linux,
    );
    expect(config).toMatchObject({
      apiKey: API_KEY,
      baseUrl: "https://api.example.test/json",
      budgetRub: 12.5,
      autoApproveRub: 0,
      freeOnly: true,
      cacheDir: "/c",
      cacheTtlDays: { frequency: 3, competition: 2, report: 0.5 },
      noCache: true,
      stateDir: "/s",
      prices: { "parser.direct": 0.05 },
      concurrency: 4,
      rps: 5,
    });
  });

  it("follows XDG and Windows conventions", () => {
    expect(loadConfig({ XDG_CACHE_HOME: "/xc", XDG_STATE_HOME: "/xs" }, linux)).toMatchObject({
      cacheDir: "/xc/mutagen-ru-mcp",
      stateDir: "/xs/mutagen-ru-mcp",
    });
    const windows = loadConfig(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      { platform: "win32", homedir: "C:\\Users\\u" },
    );
    expect(windows.cacheDir).toBe("C:\\Users\\u\\AppData\\Local\\mutagen-ru-mcp\\cache");
    expect(windows.stateDir).toBe("C:\\Users\\u\\AppData\\Local\\mutagen-ru-mcp\\state");
    expect(loadConfig({}, { platform: "win32", homedir: "C:\\Users\\u" }).cacheDir).toBe(
      "C:\\Users\\u\\AppData\\Local\\mutagen-ru-mcp\\cache",
    );
    expect(loadConfig({ MUTAGEN_API_KEY: "" }, {}).cacheDir).toContain("mutagen-ru-mcp");
  });

  it("rejects invalid values with a clear message", () => {
    expect(() => loadConfig({ MUTAGEN_BUDGET_RUB: "-1" }, linux)).toThrow(MutagenError);
    expect(() => loadConfig({ MUTAGEN_FREE_ONLY: "maybe" }, linux)).toThrow(/MUTAGEN_FREE_ONLY/);
    expect(() => loadConfig({ MUTAGEN_BASE_URL: "ftp://x" }, linux)).toThrow(/MUTAGEN_BASE_URL/);
    expect(() => loadConfig({ MUTAGEN_PRICES_JSON: "{" }, linux)).toThrow(/JSON/);
    expect(() => loadConfig({ MUTAGEN_CONCURRENCY: "0" }, linux)).toThrow(/MUTAGEN_CONCURRENCY/);
    expect(() => loadConfig({ MUTAGEN_RPS: "1.5" }, linux)).toThrow(/MUTAGEN_RPS/);
  });

  it("hides the API key from JSON, inspect and spreading", () => {
    const config = loadConfig({ MUTAGEN_API_KEY: API_KEY }, linux);
    expect(config.apiKey).toBe(API_KEY);
    expect(JSON.stringify(config)).not.toContain(API_KEY);
    expect(inspect(config, { depth: 5 })).not.toContain(API_KEY);
    expect(inspect(config, { depth: 5, showHidden: true, getters: true })).not.toContain(API_KEY);
    expect(JSON.stringify({ ...config })).not.toContain(API_KEY);
    expect(Object.keys(config)).not.toContain("apiKey");
  });
});
