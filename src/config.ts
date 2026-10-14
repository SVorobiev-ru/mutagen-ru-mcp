import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { type PriceOverrides, parsePriceOverrides } from "./budget/pricing.js";
import { DEFAULT_CACHE_TTL_DAYS } from "./cache/file-cache.js";
import { validationError } from "./core/errors.js";
import { DEFAULT_RATE_LIMIT } from "./core/rate-limit.js";
import { DEFAULT_BASE_URL } from "./core/transport.js";

export const APP_DIR_NAME = "mutagen-ru-mcp";

export interface MutagenConfig {
  readonly apiKey: string | undefined;
  baseUrl: string;
  budgetRub: number;
  autoApproveRub: number;
  freeOnly: boolean;
  cacheDir: string;
  cacheTtlDays: { frequency: number; competition: number; report: number };
  noCache: boolean;
  stateDir: string;
  prices: PriceOverrides;
  concurrency: number;
  rps: number;
}

export interface SystemInfo {
  platform?: NodeJS.Platform;
  homedir?: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

function amount(fallback: number) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+([.,]\d+)?$/, "expected a non-negative number")
      .transform((value) => Number(value.replace(",", ".")))
      .default(fallback),
  );
}

function count(fallback: number) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[1-9]\d*$/, "expected a positive integer")
      .transform(Number)
      .default(fallback),
  );
}

const flag = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => ["0", "1", "true", "false", "yes", "no", "on", "off"].includes(value), {
      message: "expected 0 or 1",
    })
    .transform((value) => ["1", "true", "yes", "on"].includes(value))
    .default(false),
);

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

const envSchema = z.object({
  MUTAGEN_API_KEY: optionalText,
  MUTAGEN_BASE_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^https?$/ }).default(DEFAULT_BASE_URL),
  ),
  MUTAGEN_BUDGET_RUB: amount(50),
  MUTAGEN_AUTO_APPROVE_RUB: amount(1),
  MUTAGEN_FREE_ONLY: flag,
  MUTAGEN_CACHE_DIR: optionalText,
  MUTAGEN_CACHE_TTL_FREQUENCY_DAYS: amount(DEFAULT_CACHE_TTL_DAYS.frequency),
  MUTAGEN_CACHE_TTL_COMPETITION_DAYS: amount(DEFAULT_CACHE_TTL_DAYS.competition),
  MUTAGEN_CACHE_TTL_REPORT_DAYS: amount(DEFAULT_CACHE_TTL_DAYS.report),
  MUTAGEN_NO_CACHE: flag,
  MUTAGEN_STATE_DIR: optionalText,
  MUTAGEN_PRICES_JSON: optionalText,
  MUTAGEN_CONCURRENCY: count(DEFAULT_RATE_LIMIT.concurrency),
  MUTAGEN_RPS: count(DEFAULT_RATE_LIMIT.perSecond),
});

class Config implements MutagenConfig {
  readonly #apiKey: string | undefined;
  baseUrl: string;
  budgetRub: number;
  autoApproveRub: number;
  freeOnly: boolean;
  cacheDir: string;
  cacheTtlDays: { frequency: number; competition: number; report: number };
  noCache: boolean;
  stateDir: string;
  prices: PriceOverrides;
  concurrency: number;
  rps: number;

  constructor(apiKey: string | undefined, values: Omit<MutagenConfig, "apiKey">) {
    this.#apiKey = apiKey;
    this.baseUrl = values.baseUrl;
    this.budgetRub = values.budgetRub;
    this.autoApproveRub = values.autoApproveRub;
    this.freeOnly = values.freeOnly;
    this.cacheDir = values.cacheDir;
    this.cacheTtlDays = values.cacheTtlDays;
    this.noCache = values.noCache;
    this.stateDir = values.stateDir;
    this.prices = values.prices;
    this.concurrency = values.concurrency;
    this.rps = values.rps;
  }

  get apiKey(): string | undefined {
    return this.#apiKey;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Omit<MutagenConfig, "apiKey"> {
    return { ...this };
  }
}

function defaultDirs(env: Env, system: SystemInfo) {
  const platform = system.platform ?? process.platform;
  const home = system.homedir ?? homedir();
  if (platform === "win32") {
    const base = blankToUndefined(env.LOCALAPPDATA) ?? win32.join(home, "AppData", "Local");
    return {
      cacheDir: win32.join(base as string, APP_DIR_NAME, "cache"),
      stateDir: win32.join(base as string, APP_DIR_NAME, "state"),
    };
  }
  const cacheBase = blankToUndefined(env.XDG_CACHE_HOME) ?? posix.join(home, ".cache");
  const stateBase = blankToUndefined(env.XDG_STATE_HOME) ?? posix.join(home, ".local", "state");
  return {
    cacheDir: posix.join(cacheBase as string, APP_DIR_NAME),
    stateDir: posix.join(stateBase as string, APP_DIR_NAME),
  };
}

export function loadConfig(env: Env = process.env, system: SystemInfo = {}): MutagenConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw validationError(
      `Invalid configuration: ${issues}`,
      `Неверные настройки в переменных окружения: ${issues}.`,
      `Invalid environment settings: ${issues}.`,
    );
  }
  const values = parsed.data;
  const dirs = defaultDirs(env, system);
  return new Config(values.MUTAGEN_API_KEY, {
    baseUrl: values.MUTAGEN_BASE_URL,
    budgetRub: values.MUTAGEN_BUDGET_RUB,
    autoApproveRub: values.MUTAGEN_AUTO_APPROVE_RUB,
    freeOnly: values.MUTAGEN_FREE_ONLY,
    cacheDir: values.MUTAGEN_CACHE_DIR ?? dirs.cacheDir,
    cacheTtlDays: {
      frequency: values.MUTAGEN_CACHE_TTL_FREQUENCY_DAYS,
      competition: values.MUTAGEN_CACHE_TTL_COMPETITION_DAYS,
      report: values.MUTAGEN_CACHE_TTL_REPORT_DAYS,
    },
    noCache: values.MUTAGEN_NO_CACHE,
    stateDir: values.MUTAGEN_STATE_DIR ?? dirs.stateDir,
    prices: values.MUTAGEN_PRICES_JSON ? parsePriceOverrides(values.MUTAGEN_PRICES_JSON) : {},
    concurrency: values.MUTAGEN_CONCURRENCY,
    rps: values.MUTAGEN_RPS,
  });
}
