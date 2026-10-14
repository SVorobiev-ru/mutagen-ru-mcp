export interface MassEntry {
  phrase: string;
  value: unknown;
}

export type MassData = { recognized: true; entries: MassEntry[] } | { recognized: false };

const PHRASE_KEYS = ["key", "keyword", "phrase"] as const;
const WRAPPER_KEYS = ["data", "result", "results", "items", "list", "keys"];
const MAX_DEPTH = 3;

export const UNRECOGNIZED_WARNING =
  "Формат данных массового задания не распознан, данные выданы как есть в колонке raw (JSON). Unrecognized mass task data format: returned as raw JSON.";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phraseOf(item: Record<string, unknown>): [string, string] | undefined {
  for (const key of PHRASE_KEYS) {
    const value = item[key];
    if (typeof value === "string" && value.trim() !== "") return [key, value];
  }
  return undefined;
}

function unwrap(value: Record<string, unknown>): unknown {
  const { data, ...rest } = value;
  if (isRecord(data)) return { ...rest, ...data };
  if (data !== undefined && Object.keys(rest).length === 0) return data;
  return value;
}

function fromItems(items: readonly unknown[]): MassEntry[] | undefined {
  const entries: MassEntry[] = [];
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    const found = phraseOf(item);
    if (!found) return undefined;
    const [field, phrase] = found;
    const { [field]: _, ...rest } = item;
    entries.push({ phrase, value: unwrap(rest) });
  }
  return entries;
}

function isScalar(value: unknown): boolean {
  return value === null || ["number", "string", "boolean"].includes(typeof value);
}

function parse(data: unknown, depth: number): MassEntry[] | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(data)) return fromItems(data);
  if (!isRecord(data)) return undefined;
  const keys = Object.keys(data);
  const values = Object.values(data);
  if (keys.length === 0) return [];
  const single = keys.length === 1 ? keys[0] : undefined;
  if (single !== undefined && WRAPPER_KEYS.includes(single)) {
    const inner = data[single];
    if (Array.isArray(inner) || isRecord(inner)) return parse(inner, depth + 1);
  }
  if (values.every((value) => isRecord(value) && phraseOf(value))) return fromItems(values);
  if (values.every((value) => isScalar(value) || isRecord(value))) {
    return keys.map((phrase) => {
      const value = data[phrase];
      return { phrase, value: isRecord(value) ? unwrap(value) : value };
    });
  }
  return undefined;
}

export function normalizeMassData(data: unknown): MassData {
  if (data === undefined || data === null) return { recognized: true, entries: [] };
  const entries = parse(data, 0);
  return entries ? { recognized: true, entries } : { recognized: false };
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+([.,]\d+)?$/.test(value.trim())) {
    return Number(value.trim().replace(",", "."));
  }
  return null;
}

export function frequencyOf(value: unknown, parser: string): number | null {
  if (!isRecord(value)) return toNumber(value);
  for (const key of ["frequency", parser]) {
    if (value[key] !== undefined) return toNumber(value[key]);
  }
  const numbers = Object.values(value).filter((item) => toNumber(item) !== null);
  return numbers.length === 1 ? toNumber(numbers[0]) : null;
}

export function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  if (!isRecord(value))
    return { [prefix || "value"]: Array.isArray(value) ? JSON.stringify(value) : value };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (isRecord(item)) Object.assign(result, flatten(item, name));
    else result[name] = Array.isArray(item) ? JSON.stringify(item) : item;
  }
  return result;
}

export function phraseKey(phrase: string): string {
  return phrase.trim().replace(/\s+/g, " ").toLowerCase();
}
