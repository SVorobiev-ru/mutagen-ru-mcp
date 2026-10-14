import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PollStep, poll } from "../../../src/core/polling.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function sequence<T>(...steps: PollStep<T>[]) {
  const queue = [...steps];
  const times: number[] = [];
  const start = Date.now();
  const check = vi.fn(async () => {
    times.push(Date.now() - start);
    const step = queue.length > 1 ? queue.shift() : queue[0];
    if (!step) throw new Error("no step");
    return step;
  });
  return { check, times };
}

describe("poll", () => {
  it("returns immediately when the first check is done", async () => {
    const { check } = sequence({ state: "done", value: 42 });
    await expect(poll(check, { timeoutMs: 1000 })).resolves.toBe(42);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("backs off from 2 s by ×1.5 up to 15 s", async () => {
    const pending: PollStep<string> = { state: "pending", status: "process" };
    const { check, times } = sequence(...Array<PollStep<string>>(8).fill(pending), {
      state: "done",
      value: "ok",
    });
    const result = poll(check, { timeoutMs: 120_000 });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ok");
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    expect(gaps).toEqual([2000, 3000, 4500, 6750, 10125, 15000, 15000, 15000]);
  });

  it("passes the attempt number to the check", async () => {
    const { check } = sequence<number>({ state: "pending" }, { state: "done", value: 1 });
    const result = poll(check, { timeoutMs: 10_000 });
    await vi.runAllTimersAsync();
    await result;
    expect(check.mock.calls.map((call) => (call as unknown[])[0])).toEqual([1, 2]);
  });

  it.each(["rejected", "error", "stop"])("fails at once on terminal status %s", async (status) => {
    const { check } = sequence<number>(
      { state: "pending", status: "created" },
      { state: "failed", status, message: "details" },
    );
    const assertion = expect(
      poll(check, { timeoutMs: 600_000, label: "task 7" }),
    ).rejects.toMatchObject({
      kind: "task_failed",
      retryable: false,
      message: `task 7 finished with status "${status}": details`,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("fails with poll_timeout when the deadline passes", async () => {
    const { check, times } = sequence<number>({ state: "pending", status: "process" });
    const assertion = expect(
      poll(check, { timeoutMs: 10_000, label: "mass 5" }),
    ).rejects.toMatchObject({
      kind: "poll_timeout",
      message: 'mass 5 is not ready after 10000 ms (last status "process")',
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(times).toEqual([0, 2000, 5000, 9500, 10000]);
  });

  it("reports a timeout without status", async () => {
    const { check } = sequence<number>({ state: "pending" });
    const assertion = expect(poll(check, { timeoutMs: 0 })).rejects.toMatchObject({
      message: "task is not ready after 0 ms",
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("stops when aborted during a pause", async () => {
    const { check } = sequence<number>({ state: "pending" });
    const controller = new AbortController();
    const assertion = expect(
      poll(check, { timeoutMs: 60_000, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await assertion;
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not check with an already aborted signal", async () => {
    const { check } = sequence<number>({ state: "done", value: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(poll(check, { timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject(
      {
        kind: "aborted",
      },
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("honours custom intervals", async () => {
    const { check, times } = sequence<number>(
      { state: "pending" },
      { state: "pending" },
      { state: "done", value: 1 },
    );
    const result = poll(check, {
      timeoutMs: 10_000,
      initialIntervalMs: 100,
      factor: 2,
      maxIntervalMs: 150,
    });
    await vi.runAllTimersAsync();
    await result;
    expect(times).toEqual([0, 100, 250]);
  });
});
