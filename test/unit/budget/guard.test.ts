import { describe, expect, it, vi } from "vitest";
import { estimatePlan } from "../../../src/budget/estimate.js";
import { type BudgetError, isBudgetError, SpendGuard } from "../../../src/budget/guard.js";
import { resolvePrices } from "../../../src/budget/pricing.js";
import { MutagenError } from "../../../src/core/errors.js";

const plan = (phrases: number) =>
  estimatePlan([{ method: "parser.mass.new", parsers: ["wordstat_n"], phrases }]);

async function refusal(promise: Promise<unknown>): Promise<BudgetError> {
  try {
    await promise;
  } catch (error) {
    expect(isBudgetError(error)).toBe(true);
    return error as BudgetError;
  }
  throw new Error("Expected a BudgetError");
}

function clock(start = Date.parse("2026-10-14T10:00:00Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SpendGuard", () => {
  it("rejects paid calls in free-only mode and lets free ones pass", async () => {
    const guard = new SpendGuard({ freeOnly: true });
    const error = await refusal(guard.authorize({ label: "f", planHash: "h", estimate: plan(1) }));
    expect(error.kind).toBe("free_only");
    expect(error.hintRu).toMatch(/только бесплатное/);
    const free = await guard.authorize({
      label: "serp",
      planHash: "s",
      estimate: estimatePlan([{ method: "serp.report" }]),
    });
    free.close();
    expect(guard.spending()).toMatchObject({ spentRub: 0, quotaRequests: 1, freeOnly: true });
  });

  it("refuses an estimate above the remaining budget", async () => {
    const guard = new SpendGuard({ budgetRub: 1, autoApproveRub: 10 });
    const error = await refusal(guard.authorize({ label: "f", planHash: "h", estimate: plan(51) }));
    expect(error.kind).toBe("over_budget");
    expect(error.remainingRub).toBe(1);
    expect(error.estimate.totalRub).toBe(1.02);
    expect(error.toJSON()).toMatchObject({ kind: "over_budget", remainingRub: 1 });
  });

  it("issues a one-time confirm token bound to the plan", async () => {
    const guard = new SpendGuard({ autoApproveRub: 1 });
    const request = { label: "f", planHash: "plan-a", estimate: plan(100) };
    const first = await refusal(guard.authorize(request));
    expect(first.kind).toBe("needs_confirmation");
    expect(first.estimate.totalRub).toBe(2);
    const token = first.confirmToken ?? "";
    expect(token).not.toBe("");

    const other = await refusal(
      guard.authorize({ ...request, planHash: "plan-b", confirmToken: token }),
    );
    expect(other.kind).toBe("needs_confirmation");
    expect(other.message).toMatch(/another plan/);

    const reservation = await guard.authorize({ ...request, confirmToken: token });
    expect(guard.spending().reservedRub).toBe(2);
    reservation.charge(200);
    reservation.close();

    const reused = await refusal(guard.authorize({ ...request, confirmToken: token }));
    expect(reused.kind).toBe("needs_confirmation");
    expect(guard.spending()).toMatchObject({ spentRub: 2, reservedRub: 0, remainingRub: 48 });
  });

  it("expires tokens after the TTL", async () => {
    const time = clock();
    const guard = new SpendGuard({ now: time.now });
    const request = { label: "f", planHash: "p", estimate: plan(100) };
    const token = (await refusal(guard.authorize(request))).confirmToken ?? "";
    time.advance(10 * 60_000 + 1);
    expect((await refusal(guard.authorize({ ...request, confirmToken: token }))).kind).toBe(
      "needs_confirmation",
    );
    expect((await refusal(guard.authorize({ ...request, confirmToken: "garbage" }))).kind).toBe(
      "needs_confirmation",
    );
    expect((await refusal(guard.authorize({ ...request, confirmToken: "a.zz.bad" }))).kind).toBe(
      "needs_confirmation",
    );
  });

  it("does not ask for confirmation under the auto-approve limit", async () => {
    const guard = new SpendGuard();
    const reservation = await guard.authorize({ label: "f", planHash: "p", estimate: plan(50) });
    expect(guard.spending().reservedRub).toBe(1);
    reservation.close("failed");
    expect(guard.spending()).toMatchObject({ spentRub: 0, reservedRub: 0, remainingRub: 50 });
    expect(guard.spending().calls[0]).toMatchObject({ label: "f", status: "failed", spentRub: 0 });
  });

  it("releases the unused reserve and counts overspending", async () => {
    const guard = new SpendGuard({ autoApproveRub: 100 });
    const a = await guard.authorize({ label: "a", planHash: "a", estimate: plan(100) });
    a.charge(50);
    expect(guard.spending()).toMatchObject({ spentRub: 0.5, reservedRub: 1.5 });
    a.close();
    a.charge(10);
    a.close();
    expect(guard.spending()).toMatchObject({ spentRub: 0.5, reservedRub: 0 });
    const b = await guard.authorize({ label: "b", planHash: "b", estimate: plan(1) });
    b.charge(5);
    b.close();
    expect(b.closed).toBe(true);
    expect(guard.spending()).toMatchObject({ spentRub: 0.55, reservedRub: 0, remainingRub: 49.45 });
  });

  it("checks the balance above 5 RUB", async () => {
    const balance = vi.fn(async () => 3);
    const guard = new SpendGuard({ autoApproveRub: 100, balance });
    await guard.authorize({ label: "small", planHash: "s", estimate: plan(250) });
    expect(balance).not.toHaveBeenCalled();
    const error = await refusal(
      guard.authorize({ label: "big", planHash: "b", estimate: plan(251) }),
    );
    expect(balance).toHaveBeenCalledTimes(1);
    expect(error.kind).toBe("low_balance");
    expect(error.balanceRub).toBe(3);

    balance.mockResolvedValueOnce(100);
    const ok = await guard.authorize({ label: "big", planHash: "b", estimate: plan(251) });
    expect(ok.estimate.totalRub).toBe(5.02);
  });

  it("rechecks the budget after waiting for the balance", async () => {
    let release: () => void = () => {};
    const guard = new SpendGuard({
      budgetRub: 10,
      autoApproveRub: 100,
      balance: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(100);
        }),
    });
    const pending = guard.authorize({ label: "big", planHash: "b", estimate: plan(300) });
    await Promise.resolve();
    await guard.authorize({ label: "small", planHash: "s", estimate: plan(250) });
    release();
    expect((await refusal(pending)).kind).toBe("over_budget");
  });

  it("validates its options", () => {
    expect(() => new SpendGuard({ budgetRub: -1 })).toThrow(MutagenError);
    expect(() => new SpendGuard({ autoApproveRub: Number.NaN })).toThrow(MutagenError);
    for (const tokenTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SpendGuard({ tokenTtlMs })).toThrow(MutagenError);
    }
    expect(new SpendGuard({ budgetRub: 12.345 }).budgetKopecks).toBe(1235);
  });

  it("refuses paid methods in free-only mode even when the estimate is zero, but lets paid parser.get phrases poll", async () => {
    const guard = new SpendGuard({ freeOnly: true });
    const repeat = estimatePlan([{ method: "check_key.new", phrases: 1, repeatPhrases: 1 }]);
    expect(repeat.totalKopecks).toBe(0);
    const error = await refusal(guard.authorize({ label: "c", planHash: "c", estimate: repeat }));
    expect(error.kind).toBe("free_only");
    expect(error.hintRu).toMatch(/check_key\.new/);
    const free = estimatePlan(
      [{ method: "parser.mass.new", parsers: ["wordstat_n"], phrases: 3 }],
      resolvePrices({ "parser.wordstat_n": 0 }),
    );
    expect(
      (await refusal(guard.authorize({ label: "f", planHash: "f", estimate: free }))).kind,
    ).toBe("free_only");
    const pending = estimatePlan([
      { method: "parser.get", parsers: ["wordstat_n"], phrases: 1, pendingPhrases: 1 },
    ]);
    const polling = await guard.authorize({ label: "g", planHash: "g", estimate: pending });
    polling.close();
    const fresh = estimatePlan([
      { method: "parser.get", parsers: ["wordstat_n"], phrases: 2, pendingPhrases: 1 },
    ]);
    expect(
      (await refusal(guard.authorize({ label: "h", planHash: "h", estimate: fresh }))).kind,
    ).toBe("free_only");
  });

  it("always asks to confirm unconfirmed prices", async () => {
    const guard = new SpendGuard({ autoApproveRub: 10 });
    const estimate = estimatePlan(
      [{ method: "parser.mass.new", parsers: ["direct"], phrases: 1 }],
      resolvePrices({ "parser.direct": { rub: 0.02, confirmed: false } }),
    );
    expect(estimate.warnings[0]).toMatch(/Цена не подтверждена: parser\.direct/);
    const error = await refusal(guard.authorize({ label: "d", planHash: "d", estimate }));
    expect(error.kind).toBe("needs_confirmation");
    expect(error.hintRu).toMatch(/Цена не подтверждена/);
    const reservation = await guard.authorize({
      label: "d",
      planHash: "d",
      estimate,
      confirmToken: error.confirmToken,
    });
    expect(reservation.estimate.totalRub).toBe(0.02);
  });

  it("keeps the token valid when the balance check refuses", async () => {
    let balance = 1;
    const guard = new SpendGuard({ autoApproveRub: 1, balance: async () => balance });
    const request = { label: "f", planHash: "h", estimate: plan(400) };
    const token = (await refusal(guard.authorize(request))).confirmToken ?? "";
    const low = await refusal(guard.authorize({ ...request, confirmToken: token }));
    expect(low.kind).toBe("low_balance");
    balance = 100;
    const reservation = await guard.authorize({ ...request, confirmToken: token });
    expect(reservation.estimate.totalRub).toBe(8);
    expect((await refusal(guard.authorize({ ...request, confirmToken: token }))).kind).toBe(
      "needs_confirmation",
    );
  });

  it("counts reserved money against the balance", async () => {
    const guard = new SpendGuard({ autoApproveRub: 100, balance: async () => 10 });
    await guard.authorize({ label: "a", planHash: "a", estimate: plan(300) });
    const error = await refusal(
      guard.authorize({ label: "b", planHash: "b", estimate: plan(300) }),
    );
    expect(error.kind).toBe("low_balance");
    expect(error.hintRu).toMatch(/зарезервировано/);
  });

  it("adds retried quota requests to the spending record", async () => {
    const guard = new SpendGuard();
    const reservation = await guard.authorize({
      label: "serp",
      planHash: "s",
      estimate: estimatePlan([{ method: "serp.report" }]),
    });
    reservation.addQuota(2);
    reservation.close();
    reservation.addQuota(5);
    expect(guard.spending().quotaRequests).toBe(3);
  });
});
