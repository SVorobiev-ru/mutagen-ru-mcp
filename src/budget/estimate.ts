import { validationError } from "../core/errors.js";
import type { ParserType } from "../core/types.js";
import { requireParser } from "../core/validate.js";
import {
  DEFAULT_PRICES,
  type FreeMethod,
  type PriceKey,
  type PriceTable,
  parserPriceKey,
  toKopecks,
} from "./pricing.js";

export type PlannedCall =
  | { method: "check_key.new"; phrases: number; repeatPhrases?: number }
  | {
      method: "parser.get";
      parsers: readonly ParserType[];
      phrases: number;
      /** Phrases already paid and still processing: polling them is free. */
      pendingPhrases?: number;
    }
  | { method: "parser.mass.new"; parsers: readonly ParserType[]; phrases: number }
  | { method: "serp.report"; requests?: number }
  | { method: FreeMethod; requests?: number };

export interface EstimateItem {
  method: PlannedCall["method"];
  parser?: ParserType;
  units: number;
  billableUnits: number;
  unitRub: number;
  rub: number;
  kopecks: number;
  confirmed: boolean;
  requiresSubscription: boolean;
  quotaRequests: number;
}

export interface Estimate {
  totalRub: number;
  totalKopecks: number;
  items: EstimateItem[];
  quotaRequests: number;
  requiresSubscription: boolean;
  unconfirmedPrices: boolean;
  warnings: string[];
}

function count(name: string, value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw validationError(
      `${name} must be a non-negative integer`,
      `${name} должно быть неотрицательным целым числом.`,
      `${name} must be a non-negative integer.`,
    );
  }
  return result;
}

function freeUnits(name: string, value: number | undefined, phrases: number): number {
  const result = count(name, value, 0);
  if (result > phrases) {
    throw validationError(
      `${name} cannot exceed phrases`,
      `${name}: таких фраз не может быть больше, чем всех фраз.`,
      `${name} cannot exceed phrases.`,
    );
  }
  return result;
}

function item(
  prices: PriceTable,
  key: PriceKey,
  method: PlannedCall["method"],
  units: number,
  billableUnits: number,
  parser?: ParserType,
): EstimateItem {
  const price = prices[key];
  const kopecks = toKopecks(price.rub, key) * billableUnits;
  return {
    method,
    ...(parser ? { parser } : {}),
    units,
    billableUnits,
    unitRub: price.rub,
    rub: kopecks / 100,
    kopecks,
    confirmed: price.confirmed,
    requiresSubscription: price.requiresSubscription ?? false,
    quotaRequests: (price.quotaRequests ?? 0) * billableUnits,
  };
}

function itemsOf(call: PlannedCall, prices: PriceTable): EstimateItem[] {
  switch (call.method) {
    case "check_key.new": {
      const phrases = count("phrases", call.phrases, 0);
      const repeats = freeUnits("repeatPhrases", call.repeatPhrases, phrases);
      return [item(prices, "check_key.new", call.method, phrases, phrases - repeats)];
    }
    case "parser.get":
    case "parser.mass.new": {
      const phrases = count("phrases", call.phrases, 0);
      const pending =
        call.method === "parser.get"
          ? freeUnits("pendingPhrases", call.pendingPhrases, phrases)
          : 0;
      return call.parsers.map((value) => {
        const parser = requireParser(value);
        return item(
          prices,
          parserPriceKey(parser),
          call.method,
          phrases,
          phrases - pending,
          parser,
        );
      });
    }
    default: {
      const requests = count("requests", call.requests, 1);
      return [item(prices, call.method, call.method, requests, requests)];
    }
  }
}

export function estimatePlan(
  calls: readonly PlannedCall[],
  prices: PriceTable = DEFAULT_PRICES,
): Estimate {
  return estimateOf(calls.flatMap((call) => itemsOf(call, prices)));
}

/** One estimate for several planned steps. */
export function mergeEstimates(estimates: readonly Estimate[]): Estimate {
  return estimateOf(estimates.flatMap((estimate) => estimate.items));
}

function estimateOf(items: EstimateItem[]): Estimate {
  const totalKopecks = items.reduce((sum, entry) => sum + entry.kopecks, 0);
  const unconfirmed = [
    ...new Set(
      items
        .filter((entry) => !entry.confirmed && entry.billableUnits > 0)
        .map((entry) => (entry.parser ? `parser.${entry.parser}` : entry.method)),
    ),
  ];
  return {
    totalRub: totalKopecks / 100,
    totalKopecks,
    items,
    quotaRequests: items.reduce((sum, entry) => sum + entry.quotaRequests, 0),
    requiresSubscription: items.some((entry) => entry.requiresSubscription),
    unconfirmedPrices: unconfirmed.length > 0,
    warnings:
      unconfirmed.length > 0
        ? [
            `Цена не подтверждена: ${unconfirmed.join(", ")} — смета приблизительная. Price not confirmed: the estimate is approximate.`,
          ]
        : [],
  };
}

export function formatRub(kopecks: number): string {
  return (kopecks / 100).toFixed(2);
}
