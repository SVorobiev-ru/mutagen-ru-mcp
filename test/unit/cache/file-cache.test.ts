import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestHash } from "../../../src/budget/hash.js";
import { cacheCategory, FileCache } from "../../../src/cache/file-cache.js";

const dirs: string[] = [];
const DAY = 24 * 60 * 60_000;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mutagen-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(dir: string, options: Partial<ConstructorParameters<typeof FileCache>[0]> = {}) {
  let now = Date.parse("2026-10-14T10:00:00Z");
  const cache = new FileCache({ dir, now: () => now, ...options });
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const key = requestHash("parser.get", { key: "окна" });

describe("FileCache", () => {
  it("misses, hits and expires by category TTL", async () => {
    const dir = join(await tempDir(), "cache");
    const { cache, advance } = setup(dir);
    expect(await cache.get(key)).toBeUndefined();
    expect(await cache.set(key, "report", { rows: [1] })).toBe(true);
    expect(await cache.get(key)).toEqual({ rows: [1] });
    advance(DAY - 1);
    expect(await cache.get(key)).toEqual({ rows: [1] });
    advance(1);
    expect(await cache.get(key)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("uses 7 days for frequency and competition by default and custom TTLs", async () => {
    const { cache } = setup(await tempDir(), { ttlDays: { report: 2 } });
    expect(cache.ttlMs).toEqual({ frequency: 7 * DAY, competition: 7 * DAY, report: 2 * DAY });
  });

  it("writes atomically without leftover temp files", async () => {
    const dir = await tempDir();
    const { cache } = setup(dir);
    await cache.set(key, "frequency", { a: 1 });
    await cache.set(key, "frequency", { a: 2 });
    expect(await readdir(dir)).toEqual([`${key}.json`]);
    const stored = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8"));
    expect(stored).toMatchObject({ category: "frequency", value: { a: 2 } });
  });

  it("honours noCache, forceRefresh, disabled and zero TTL", async () => {
    const dir = await tempDir();
    const { cache } = setup(dir, { ttlDays: { competition: 0 } });
    await cache.set(key, "frequency", 1);
    expect(await cache.get(key, { forceRefresh: true })).toBeUndefined();
    expect(await cache.get(key, { noCache: true })).toBeUndefined();
    expect(await cache.get(key)).toBe(1);
    expect(await cache.set(key, "frequency", 2, { noCache: true })).toBe(false);
    expect(await cache.set(key, "competition", 2)).toBe(false);
    const disabled = setup(dir, { disabled: true }).cache;
    expect(await disabled.get(key)).toBeUndefined();
    expect(await disabled.set(key, "frequency", 3)).toBe(false);
    await cache.delete(key);
    expect(await cache.get(key)).toBeUndefined();
  });

  it("drops broken entries and purges expired ones", async () => {
    const dir = await tempDir();
    const { cache, advance } = setup(dir);
    const other = requestHash("serp.report", {});
    const third = requestHash("check_key.new", { key: "x" });
    await cache.set(key, "report", 1);
    await cache.set(other, "frequency", 2);
    await writeFile(join(dir, `${third}.json`), "{broken");
    await writeFile(join(dir, "notes.txt"), "keep");
    expect(await cache.get(third)).toBeUndefined();
    await writeFile(join(dir, `${third}.json`), JSON.stringify({ value: 1 }));
    expect(await cache.get(third)).toBeUndefined();
    await writeFile(join(dir, `${third}.json`), "[]");
    advance(2 * DAY);
    expect(await cache.purgeExpired()).toBe(2);
    expect((await readdir(dir)).sort()).toEqual([`${other}.json`, "notes.txt"].sort());
    expect(await new FileCache({ dir: join(dir, "missing") }).purgeExpired()).toBe(0);
  });

  it("rejects keys that are not hashes", async () => {
    const { cache } = setup(await tempDir());
    await expect(cache.get("../etc/passwd")).rejects.toThrow(/Invalid cache key/);
  });

  it("reports write failures as a miss and cleans up", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, `${key}.json`));
    await writeFile(join(dir, `${key}.json`, "x"), "");
    const { cache } = setup(dir);
    await expect(cache.set(key, "frequency", 1)).resolves.toBe(false);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(cache.get(key)).resolves.toBeUndefined();
    expect(await readdir(join(dir, `${key}.json`))).toEqual(["x"]);
  });

  it("treats a file in place of the cache directory as no cache", async () => {
    const file = join(await tempDir(), "cache");
    await writeFile(file, "x");
    const { cache } = setup(file);
    await expect(cache.set(key, "frequency", 1)).resolves.toBe(false);
    await expect(cache.get(key)).resolves.toBeUndefined();
  });

  it("counts expiry from createdAt with the current TTL", async () => {
    const dir = await tempDir();
    const { cache, advance } = setup(dir);
    await cache.set(key, "frequency", 1);
    advance(2 * DAY);
    expect(await cache.get(key)).toBe(1);
    const shorter = new FileCache({
      dir,
      ttlDays: { frequency: 1 },
      now: () => Date.parse("2026-10-16T10:00:00Z"),
    });
    expect(await shorter.get(key)).toBeUndefined();
    await writeFile(
      join(dir, `${key}.json`),
      JSON.stringify({ category: "frequency", expiresAt: "2099-01-01T00:00:00Z", value: 1 }),
    );
    expect(await cache.get(key)).toBeUndefined();
  });

  it("maps methods to categories and never caches live data", () => {
    expect(cacheCategory("parser.mass.new")).toBe("frequency");
    expect(cacheCategory("check_key.new")).toBe("competition");
    expect(cacheCategory("serp.report")).toBe("report");
    for (const method of ["balance", "parser.mass.list", "progects", "check_key.get"]) {
      expect(cacheCategory(method)).toBeUndefined();
    }
  });
});
