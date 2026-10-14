import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, latestEntry, reusableTask } from "../../../src/budget/ledger.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mutagen-ledger-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const base = { method: "parser.mass.new", requestHash: "h1", estimateRub: 0.2 };

describe("Ledger", () => {
  it("creates the directory and appends JSONL", async () => {
    const dir = join(await tempDir(), "nested", "state");
    const ledger = new Ledger({ dir, now: () => Date.parse("2026-10-14T10:00:00Z") });
    expect(await ledger.entries()).toEqual([]);
    await ledger.append({ ...base, status: "requested" });
    await ledger.append({ ...base, status: "created", massId: 7, chargedRub: 0.2 });
    const lines = (await readFile(ledger.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      ...base,
      status: "created",
      massId: 7,
      chargedRub: 0.2,
      ts: "2026-10-14T10:00:00.000Z",
    });
    expect(await ledger.latest("h1")).toMatchObject({ status: "created", massId: 7 });
  });

  it("skips broken lines and repairs a missing trailing newline", async () => {
    const dir = await tempDir();
    const ledger = new Ledger({ dir });
    await writeFile(
      ledger.path,
      `not json\n{"ts":"x"}\n${JSON.stringify({ ...base, ts: "2026-10-14T00:00:00Z", status: "done", massId: 1 })}\n{"trunc`,
    );
    await ledger.append({ ...base, requestHash: "h2", status: "done" });
    const entries = await ledger.entries();
    expect(entries.map((entry) => entry.requestHash)).toEqual(["h1", "h2"]);
  });

  it("finds reusable tasks within the time window", () => {
    const entries = [
      { ...base, ts: "2026-10-01T00:00:00Z", status: "done" as const, massId: 1 },
      { ...base, ts: "2026-10-10T00:00:00Z", status: "requested" as const },
      { ...base, ts: "2026-10-10T00:00:01Z", status: "created" as const, massId: 2 },
      {
        ...base,
        requestHash: "h2",
        ts: "2026-10-10T00:00:00Z",
        status: "failed" as const,
        massId: 3,
      },
      { ...base, requestHash: "h3", ts: "bad", status: "done" as const, massId: 4 },
      { ...base, requestHash: "h4", ts: "2026-10-10T00:00:00Z", status: "requested" as const },
    ];
    expect(reusableTask(entries, "h1")?.massId).toBe(2);
    expect(reusableTask(entries, "h1", Date.parse("2026-10-11T00:00:00Z"))).toBeUndefined();
    expect(reusableTask(entries, "h2")).toBeUndefined();
    expect(reusableTask(entries, "h3")).toBeUndefined();
    expect(reusableTask(entries, "h4")).toBeUndefined();
    expect(latestEntry(entries, "h4")?.status).toBe("requested");
  });

  it("reuses stopped tasks and skips done ones on request", () => {
    const entries = [
      { ...base, ts: "2026-10-10T00:00:00Z", status: "created" as const, massId: 1 },
      { ...base, ts: "2026-10-10T00:01:00Z", status: "stopped" as const, massId: 1 },
      {
        ...base,
        requestHash: "h2",
        ts: "2026-10-10T00:00:00Z",
        status: "done" as const,
        massId: 2,
      },
      { ...base, requestHash: "h3", ts: "2026-10-10T00:00:00Z", status: "cancelled" as const },
    ];
    expect(reusableTask(entries, "h1", Number.NEGATIVE_INFINITY, false)?.massId).toBe(1);
    expect(reusableTask(entries, "h2")?.massId).toBe(2);
    expect(reusableTask(entries, "h2", Number.NEGATIVE_INFINITY, false)).toBeUndefined();
    expect(reusableTask(entries, "h3")).toBeUndefined();
  });

  it("rethrows unexpected read errors", async () => {
    const dir = await tempDir();
    const ledger = new Ledger({ dir, fileName: "." });
    await expect(ledger.entries()).rejects.toThrow();
  });
});
