import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CacheCategory = "frequency" | "competition" | "report";

export const CACHE_CATEGORIES: readonly CacheCategory[] = ["frequency", "competition", "report"];

const DAY_MS = 24 * 60 * 60_000;

export const DEFAULT_CACHE_TTL_DAYS: Readonly<Record<CacheCategory, number>> = Object.freeze({
  frequency: 7,
  competition: 7,
  report: 1,
});

const CACHEABLE_METHODS: Readonly<Record<string, CacheCategory>> = Object.freeze({
  "parser.get": "frequency",
  "parser.mass.new": "frequency",
  "parser.mass.id": "frequency",
  "check_key.new": "competition",
  "serp.report": "report",
});

export function cacheCategory(method: string): CacheCategory | undefined {
  return CACHEABLE_METHODS[method];
}

export interface CacheEntry<T = unknown> {
  category: CacheCategory;
  createdAt: string;
  expiresAt: string;
  value: T;
}

export interface FileCacheOptions {
  dir: string;
  ttlDays?: Partial<Record<CacheCategory, number>>;
  disabled?: boolean;
  now?: () => number;
}

export interface CacheReadOptions {
  noCache?: boolean;
  forceRefresh?: boolean;
}

const KEY_PATTERN = /^[a-f0-9]{16,128}$/;

function isEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    CACHE_CATEGORIES.includes(entry.category as CacheCategory) &&
    typeof entry.createdAt === "string" &&
    !Number.isNaN(Date.parse(entry.createdAt)) &&
    "value" in entry
  );
}

async function remove(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch {}
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class FileCache {
  readonly dir: string;
  readonly disabled: boolean;
  readonly ttlMs: Readonly<Record<CacheCategory, number>>;
  readonly #now: () => number;

  constructor(options: FileCacheOptions) {
    this.dir = options.dir;
    this.disabled = options.disabled ?? false;
    this.#now = options.now ?? Date.now;
    const days = { ...DEFAULT_CACHE_TTL_DAYS, ...options.ttlDays };
    this.ttlMs = Object.freeze({
      frequency: days.frequency * DAY_MS,
      competition: days.competition * DAY_MS,
      report: days.report * DAY_MS,
    });
  }

  #file(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid cache key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  #expired(entry: CacheEntry, now: number): boolean {
    return Date.parse(entry.createdAt) + this.ttlMs[entry.category] <= now;
  }

  async get<T>(key: string, options: CacheReadOptions = {}): Promise<T | undefined> {
    if (this.disabled || options.noCache || options.forceRefresh) return undefined;
    const file = this.#file(key);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      await remove(file);
      return undefined;
    }
    if (!isEntry(entry) || this.#expired(entry, this.#now())) {
      await remove(file);
      return undefined;
    }
    return entry.value as T;
  }

  async set(
    key: string,
    category: CacheCategory,
    value: unknown,
    options: CacheReadOptions = {},
  ): Promise<boolean> {
    const ttl = this.ttlMs[category];
    if (this.disabled || options.noCache || !(ttl > 0)) return false;
    const file = this.#file(key);
    const now = this.#now();
    const entry: CacheEntry = {
      category,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      value,
    };
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, file);
    } catch {
      await remove(tmp);
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    await rm(this.#file(key), { force: true });
  }

  async purgeExpired(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }
    let removed = 0;
    const now = this.#now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.dir, name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      let expired: boolean;
      try {
        const entry: unknown = JSON.parse(text);
        expired = !isEntry(entry) || this.#expired(entry, now);
      } catch {
        expired = true;
      }
      if (expired) {
        await rm(file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
