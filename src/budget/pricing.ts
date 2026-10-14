import { validationError } from "../core/errors.js";
import { PARSER_TYPES, type ParserType } from "../core/types.js";

export const FREE_METHODS = [
  "balance",
  "progect.keywords",
  "check_key.get",
  "parser.mass.list",
  "parser.mass.id",
] as const;

export type FreeMethod = (typeof FREE_METHODS)[number];

export const PAID_METHODS = ["check_key.new", "parser.get", "parser.mass.new"] as const;

export type PaidMethod = (typeof PAID_METHODS)[number];

export function isPaidMethod(method: string): method is PaidMethod {
  return (PAID_METHODS as readonly string[]).includes(method);
}

export type ParserPriceKey = `parser.${ParserType}`;

export type PriceKey =
  | "check_key.new"
  | ParserPriceKey
  | "serp.report"
  | "suggest.new"
  | FreeMethod;

export interface Price {
  rub: number;
  per: "phrase" | "request";
  verifiedAt: string;
  source: string;
  confirmed: boolean;
  requiresSubscription?: boolean;
  quotaRequests?: number;
  freeRepeatDays?: number;
}

export type PriceTable = Readonly<Record<PriceKey, Readonly<Price>>>;

export type PriceOverride = number | Partial<Price>;

export type PriceOverrides = Partial<Record<PriceKey, PriceOverride>>;

const VERIFIED_AT = "2026-10-14";
const CALIBRATION = "live calibration";

/** Paid only for the first parser.get of a phrase; repeats while waiting are free. */
function parserPrice(parser: ParserType): Price {
  return {
    rub: parser === "wordstat_key" ? 0.2 : 0.02,
    per: "phrase",
    verifiedAt: VERIFIED_AT,
    source: CALIBRATION,
    confirmed: true,
  };
}

function freePrice(): Price {
  return { rub: 0, per: "request", verifiedAt: VERIFIED_AT, source: CALIBRATION, confirmed: true };
}

export const DEFAULT_PRICES: PriceTable = Object.freeze({
  "check_key.new": {
    rub: 0.3,
    per: "phrase",
    verifiedAt: VERIFIED_AT,
    source: CALIBRATION,
    confirmed: true,
    freeRepeatDays: 7,
  },
  ...(Object.fromEntries(
    PARSER_TYPES.map((parser) => [`parser.${parser}`, parserPrice(parser)]),
  ) as Record<ParserPriceKey, Price>),
  "serp.report": {
    rub: 0,
    per: "request",
    verifiedAt: VERIFIED_AT,
    source: "https://mutagen.ru/serp/?tarif",
    confirmed: true,
    requiresSubscription: true,
    quotaRequests: 1,
  },
  "suggest.new": {
    rub: 0,
    per: "phrase",
    verifiedAt: VERIFIED_AT,
    source: `${CALIBRATION} (nothing charged at creation, undocumented method)`,
    confirmed: false,
  },
  ...(Object.fromEntries(FREE_METHODS.map((method) => [method, freePrice()])) as Record<
    FreeMethod,
    Price
  >),
});

export const PRICE_KEYS = Object.keys(DEFAULT_PRICES) as PriceKey[];

export function isPriceKey(value: unknown): value is PriceKey {
  return typeof value === "string" && (PRICE_KEYS as string[]).includes(value);
}

export function parserPriceKey(parser: ParserType): ParserPriceKey {
  return `parser.${parser}`;
}

function invalidPrice(key: string, reason: string) {
  return validationError(
    `Invalid price override for ${key}: ${reason}`,
    `Неверное переопределение цены ${key}: ${reason}.`,
    `Invalid price override for ${key}: ${reason}.`,
  );
}

export function toKopecks(rub: number, key = "price"): number {
  if (!Number.isFinite(rub) || rub < 0) throw invalidPrice(key, "must be a non-negative number");
  const kopecks = Math.round(rub * 100);
  if (Math.abs(kopecks - rub * 100) > 1e-6) {
    throw invalidPrice(key, "must be a whole number of kopecks (0.01 RUB)");
  }
  return kopecks;
}

export function resolvePrices(overrides: PriceOverrides = {}): PriceTable {
  const table: Record<string, Price> = { ...DEFAULT_PRICES };
  for (const [key, override] of Object.entries(overrides)) {
    if (override === undefined) continue;
    if (!isPriceKey(key)) throw invalidPrice(key, "unknown method");
    const patch = typeof override === "number" ? { rub: override } : override;
    const price: Price = {
      ...DEFAULT_PRICES[key],
      source: "override",
      confirmed: true,
      ...patch,
    };
    toKopecks(price.rub, key);
    table[key] = price;
  }
  return Object.freeze(table) as PriceTable;
}

export function parsePriceOverrides(json: string): PriceOverrides {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw invalidPrice("MUTAGEN_PRICES_JSON", "not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPrice("MUTAGEN_PRICES_JSON", 'expected an object like {"parser.direct": 0.05}');
  }
  for (const [key, override] of Object.entries(value)) {
    const valid =
      typeof override === "number" ||
      (typeof override === "object" &&
        override !== null &&
        typeof (override as { rub?: unknown }).rub === "number");
    if (!valid) throw invalidPrice(key, "expected a number of rubles or an object with rub");
  }
  resolvePrices(value as PriceOverrides);
  return value as PriceOverrides;
}
