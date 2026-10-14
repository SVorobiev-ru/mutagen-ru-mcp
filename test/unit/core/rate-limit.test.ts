import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutagenError } from "../../../src/core/errors.js";
import { DEFAULT_RATE_LIMIT, RateLimiter } from "../../../src/core/rate-limit.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function failing(kind: "rate_limit" | "network" | "auth", code?: number) {
  return new MutagenError({
    kind,
    retryable: kind !== "auth",
    ...(code === undefined ? {} : { code }),
    message: kind,
    hintRu: "",
    hintEn: "",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter queue", () => {
  it("uses the documented defaults", () => {
    const limiter = new RateLimiter();
    expect(limiter.concurrency).toBe(2);
    expect(limiter.perSecond).toBe(3);
    expect(limiter.maxAttempts).toBe(5);
    expect(DEFAULT_RATE_LIMIT.concurrency).toBe(2);
  });

  it("runs at most `concurrency` tasks at once", async () => {
    const limiter = new RateLimiter({ concurrency: 2, perSecond: 100 });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      limiter.schedule(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(1);
    gates[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
  });

  it("starts no more than `perSecond` tasks in any second", async () => {
    const limiter = new RateLimiter({ concurrency: 10, perSecond: 3 });
    const startedAt: number[] = [];
    const t0 = Date.now();
    const runs = Array.from({ length: 7 }, () =>
      limiter.schedule(async () => {
        startedAt.push(Date.now() - t0);
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toEqual([0, 0, 0, 1000, 1000, 1000]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(startedAt).toHaveLength(7);
    await Promise.all(runs);
  });

  it("passes task errors through, including synchronous throws", async () => {
    const limiter = new RateLimiter();
    await expect(
      limiter.schedule(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(limiter.schedule(() => Promise.reject(new Error("async")))).rejects.toThrow(
      "async",
    );
    expect(limiter.active).toBe(0);
  });

  it("removes an aborted task from the queue", async () => {
    const limiter = new RateLimiter({ concurrency: 1 });
    const gate = deferred();
    const first = limiter.schedule(() => gate.promise);
    const controller = new AbortController();
    const task = vi.fn(async () => "never");
    const second = limiter.schedule(task, controller.signal);
    const assertion = expect(second).rejects.toMatchObject({ kind: "aborted", beforeStart: true });
    controller.abort();
    await assertion;
    expect(limiter.pending).toBe(0);
    gate.resolve();
    await first;
    expect(task).not.toHaveBeenCalled();
  });

  it("rejects immediately with an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new RateLimiter().schedule(async () => 1, controller.signal),
    ).rejects.toMatchObject({ kind: "aborted", beforeStart: true });
  });

  it("ignores an abort after the task has started", async () => {
    const limiter = new RateLimiter();
    const controller = new AbortController();
    const gate = deferred<string>();
    const run = limiter.schedule(() => gate.promise, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    gate.resolve("done");
    await expect(run).resolves.toBe("done");
  });

  it.each([
    [{ concurrency: 0 }],
    [{ concurrency: 1.5 }],
    [{ perSecond: -1 }],
    [{ maxAttempts: Number.NaN }],
    [{ baseDelayMs: 0 }],
    [{ maxDelayMs: Number.POSITIVE_INFINITY }],
    [{ baseDelayMs: -5 }],
  ])("rejects invalid options %j", (options) => {
    expect(() => new RateLimiter(options)).toThrow(MutagenError);
  });
});

describe("RateLimiter retries", () => {
  it("retries retryable errors with exponential backoff", async () => {
    const limiter = new RateLimiter({ perSecond: 100, random: () => 1 });
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failing("rate_limit", 110))
      .mockRejectedValueOnce(failing("network"))
      .mockResolvedValue("ok");
    const run = limiter.run(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(3);
    await expect(run).resolves.toBe("ok");
  });

  it("reports every retry to the caller", async () => {
    const limiter = new RateLimiter({ perSecond: 100 });
    const onRetry = vi.fn();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failing("rate_limit", 113))
      .mockRejectedValueOnce(failing("rate_limit", 114))
      .mockResolvedValue("ok");
    const run = limiter.run(task, { onRetry });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ code: 113 });
  });

  it("gives up after maxAttempts", async () => {
    const limiter = new RateLimiter({ perSecond: 100, maxAttempts: 5 });
    const task = vi.fn(() => Promise.reject(failing("network")));
    const assertion = expect(limiter.run(task)).rejects.toMatchObject({ kind: "network" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-retryable or foreign errors", async () => {
    const limiter = new RateLimiter();
    const auth = vi.fn(() => Promise.reject(failing("auth", 105)));
    await expect(limiter.run(auth)).rejects.toMatchObject({ code: 105 });
    expect(auth).toHaveBeenCalledTimes(1);
    const foreign = vi.fn(() => Promise.reject(new Error("plain")));
    await expect(limiter.run(foreign)).rejects.toThrow("plain");
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it("lets the caller veto a retry", async () => {
    const limiter = new RateLimiter();
    const task = vi.fn(() => Promise.reject(failing("network")));
    await expect(
      limiter.run(task, { shouldRetry: (error) => error.code !== undefined }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a retry when aborted", async () => {
    const limiter = new RateLimiter();
    const controller = new AbortController();
    const task = vi.fn(() => Promise.reject(failing("rate_limit", 110)));
    const assertion = expect(
      limiter.run(task, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("computes jittered delays capped by maxDelayMs", () => {
    const low = new RateLimiter({ random: () => 0, baseDelayMs: 1000, maxDelayMs: 5000 });
    const high = new RateLimiter({ random: () => 1, baseDelayMs: 1000, maxDelayMs: 5000 });
    expect([1, 2, 3, 4].map((attempt) => low.retryDelay(attempt))).toEqual([500, 1000, 2000, 2500]);
    expect([1, 2, 3, 4].map((attempt) => high.retryDelay(attempt))).toEqual([
      1000, 2000, 4000, 5000,
    ]);
    const random = new RateLimiter();
    for (let i = 0; i < 20; i += 1) {
      const delay = random.retryDelay(2);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});
