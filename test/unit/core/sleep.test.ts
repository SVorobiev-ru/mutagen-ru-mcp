import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../../../src/core/sleep.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const pending = sleep(500).then(done);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalled();
  });

  it("rejects at once with an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rejects when aborted while waiting", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const assertion = expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
  });
});
