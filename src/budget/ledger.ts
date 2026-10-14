import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type LedgerStatus =
  | "requested"
  | "created"
  | "done"
  | "failed"
  | "stopped"
  | "cancelled"
  | "abandoned";

export interface LedgerEntry {
  ts: string;
  method: string;
  requestHash: string;
  taskId?: number;
  massId?: number;
  estimateRub: number;
  status: LedgerStatus;
  chargedRub?: number;
}

export type LedgerInput = Omit<LedgerEntry, "ts"> & { ts?: string };

export interface LedgerOptions {
  dir: string;
  fileName?: string;
  now?: () => number;
}

export const LEDGER_FILE = "ledger.jsonl";

export const LOCK_WAIT_MS = 30_000;
export const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;

export const TASK_REUSE_DAYS = 7;
export const TASK_REUSE_MS = TASK_REUSE_DAYS * 24 * 60 * 60_000;

const STATUSES: readonly LedgerStatus[] = [
  "requested",
  "created",
  "done",
  "failed",
  "stopped",
  "cancelled",
  "abandoned",
];

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ts === "string" &&
    typeof entry.method === "string" &&
    typeof entry.requestHash === "string" &&
    typeof entry.estimateRub === "number" &&
    STATUSES.includes(entry.status as LedgerStatus)
  );
}

async function endsWithNewline(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await handle?.close();
  }
}

export class Ledger {
  readonly dir: string;
  readonly path: string;
  readonly #now: () => number;

  constructor(options: LedgerOptions) {
    this.dir = options.dir;
    this.path = join(options.dir, options.fileName ?? LEDGER_FILE);
    this.#now = options.now ?? Date.now;
  }

  async append(input: LedgerInput): Promise<LedgerEntry> {
    const entry: LedgerEntry = { ...input, ts: input.ts ?? new Date(this.#now()).toISOString() };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const prefix = (await endsWithNewline(this.path)) ? "" : "\n";
    await appendFile(this.path, `${prefix}${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return entry;
  }

  async entries(): Promise<LedgerEntry[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: LedgerEntry[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isEntry(value)) result.push(value);
      } catch {}
    }
    return result;
  }

  /**
   * Takes a lock on one request across processes: an exclusive file next to the ledger. A lock
   * older than {@link LOCK_STALE_MS} is left from a crashed process and is taken over. Resolves
   * with the release function, or `undefined` when the lock stays busy for `waitMs`.
   */
  async lock(
    requestHash: string,
    waitMs = LOCK_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<(() => Promise<void>) | undefined> {
    const dir = join(this.dir, "locks");
    const path = join(dir, `${requestHash}.lock`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
        return () => rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(LOCK_POLL_MS, undefined, signal ? { signal } : {});
    }
  }

  async latest(requestHash: string, maxAgeMs = Number.POSITIVE_INFINITY) {
    return latestEntry(await this.entries(), requestHash, this.#now() - maxAgeMs);
  }
}

export function latestEntry(
  entries: readonly LedgerEntry[],
  requestHash: string,
  sinceMs = Number.NEGATIVE_INFINITY,
): LedgerEntry | undefined {
  let found: LedgerEntry | undefined;
  for (const entry of entries) {
    if (entry.requestHash !== requestHash) continue;
    const time = Date.parse(entry.ts);
    if (Number.isNaN(time) || time < sinceMs) continue;
    found = entry;
  }
  return found;
}

export function reusableTask(
  entries: readonly LedgerEntry[],
  requestHash: string,
  sinceMs = Number.NEGATIVE_INFINITY,
  includeDone = true,
): LedgerEntry | undefined {
  const entry = latestEntry(entries, requestHash);
  if (!entry || entry.status === "failed" || entry.status === "abandoned") return undefined;
  if (entry.status === "done" && !includeDone) return undefined;
  if (entry.taskId === undefined && entry.massId === undefined) return undefined;
  return taskCreatedAt(entries, entry) >= sinceMs ? entry : undefined;
}

/** When the task of a reusable entry was created: its "created" entry, else the entry itself. */
export function taskCreatedAt(entries: readonly LedgerEntry[], entry: LedgerEntry): number {
  const created = entries.find(
    (candidate) =>
      candidate.requestHash === entry.requestHash &&
      candidate.status === "created" &&
      candidate.taskId === entry.taskId &&
      candidate.massId === entry.massId,
  );
  return Date.parse((created ?? entry).ts);
}

export function paidSince(
  entries: readonly LedgerEntry[],
  requestHash: string,
  sinceMs: number,
): boolean {
  return entries.some(
    (entry) =>
      entry.requestHash === requestHash &&
      entry.status === "created" &&
      (entry.chargedRub ?? 0) > 0 &&
      Date.parse(entry.ts) >= sinceMs,
  );
}
