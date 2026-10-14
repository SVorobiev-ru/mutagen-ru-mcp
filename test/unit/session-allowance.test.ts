import { afterEach, describe, expect, it } from "vitest";
import type { ParserRunResult } from "../../src/session.js";
import { cleanup, fakeHandlers, json, makeSession, refusal } from "./scenarios/helpers.js";

afterEach(cleanup);

const words = (n: number, prefix = "фраза") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

const plan = (
  session: Awaited<ReturnType<typeof makeSession>>["session"],
  phrases: number,
  params: Record<string, unknown> = {},
) => ({
  label: "test_plan",
  params,
  estimate: session.estimate([{ method: "parser.mass.new", parsers: ["wordstat_n"], phrases }]),
});

describe("MutagenSession.runWithAllowance", () => {
  it("asks for one confirmation for the whole plan", async () => {
    const { session, count } = await makeSession(fakeHandlers({}));
    const steps = async () => {
      const first = (await session.frequency(words(60), ["wordstat_n"])) as ParserRunResult;
      const second = (await session.frequency(words(40, "слово"), [
        "wordstat_n",
      ])) as ParserRunResult;
      return [first.dryRun, second.dryRun];
    };
    const error = await refusal(session.runWithAllowance(plan(session, 100), {}, steps));
    expect(error.kind).toBe("needs_confirmation");
    expect(count("parser.mass.new")).toBe(0);

    const result = await session.runWithAllowance(
      plan(session, 100),
      { confirmToken: error.confirmToken },
      steps,
    );
    expect(result).toMatchObject({ dryRun: false, value: [false, false], spentRub: 2 });
    expect(count("parser.mass.new")).toBe(2);
    const spending = session.spending();
    expect(spending).toMatchObject({ spentRub: 2, reservedRub: 0, remainingRub: 48 });
    expect(spending.calls).toEqual([
      expect.objectContaining({ label: "test_plan", estimateRub: 2, spentRub: 2, status: "ok" }),
    ]);
    await expect(
      session.runWithAllowance(plan(session, 100), { confirmToken: error.confirmToken }, steps),
    ).rejects.toMatchObject({ kind: "needs_confirmation" });
  });

  it("refuses nested calls beyond the approved plan and returns the rest to the budget", async () => {
    const { session, count } = await makeSession(fakeHandlers({}), { autoApproveRub: 5 });
    const result = await session.runWithAllowance(plan(session, 10), {}, async (allowance) => {
      await session.frequency(words(6), ["wordstat_n"]);
      expect(allowance.remainingKopecks).toBe(8);
      const error = await refusal(session.frequency(words(5, "слово"), ["wordstat_n"]));
      return { kind: error.kind, hint: error.hintRu, left: error.remainingRub };
    });
    expect(result).toMatchObject({
      dryRun: false,
      value: { kind: "over_allowance", left: 0.08 },
      spentRub: 0.12,
    });
    expect(count("parser.mass.new")).toBe(1);
    expect(session.spending()).toMatchObject({ spentRub: 0.12, reservedRub: 0 });
    expect(session.spending().remainingRub).toBeCloseTo(49.88);
  });

  it("shares one reserve between parallel nested calls", async () => {
    const { session, count } = await makeSession(fakeHandlers({}), { autoApproveRub: 5 });
    const result = await session.runWithAllowance(plan(session, 3), {}, () =>
      Promise.allSettled([
        session.frequency(words(2), ["wordstat_n"]),
        session.frequency(words(2, "слово"), ["wordstat_n"]),
      ]),
    );
    if (result.dryRun) throw new Error("Expected a run");
    const statuses = result.value.map((item) => item.status).sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = result.value.find((item) => item.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ kind: "over_allowance" });
    expect(count("parser.mass.new")).toBe(1);
    expect(result.spentRub).toBe(0.04);
  });

  it("keeps free-only inside the plan", async () => {
    const { session, calls } = await makeSession(fakeHandlers({}), { freeOnly: true });
    const paid = await refusal(session.runWithAllowance(plan(session, 1), {}, async () => 1));
    expect(paid.kind).toBe("free_only");
    const free = { label: "free_plan", params: {}, estimate: session.estimate([]) };
    const result = await session.runWithAllowance(free, {}, async () =>
      refusal(session.frequency(["окна"], ["wordstat_n"])),
    );
    if (result.dryRun) throw new Error("Expected a run");
    expect(result.value.kind).toBe("free_only");
    expect(calls).toHaveLength(0);
  });

  it("returns the estimate on dry run and runs nested plans inside the outer one", async () => {
    const { session, calls } = await makeSession(fakeHandlers({}), { autoApproveRub: 5 });
    let ran = false;
    const dry = await session.runWithAllowance(plan(session, 10), { dryRun: true }, async () => {
      ran = true;
    });
    expect(dry).toMatchObject({ dryRun: true, estimate: { totalRub: 0.2 } });
    expect(ran).toBe(false);
    expect(calls).toHaveLength(0);

    const outer = await session.runWithAllowance(plan(session, 2), {}, async () => {
      const inner = await session.runWithAllowance(plan(session, 50), {}, async () =>
        refusal(session.frequency(words(3), ["wordstat_n"])),
      );
      return inner;
    });
    if (outer.dryRun) throw new Error("Expected a run");
    expect(outer.value).toMatchObject({ dryRun: false, spentRub: 0 });
    expect((outer.value as { value: { kind: string } }).value.kind).toBe("over_allowance");
  });

  it("closes the plan as failed when the steps throw", async () => {
    const { session } = await makeSession(fakeHandlers({}), { autoApproveRub: 5 });
    await expect(
      session.runWithAllowance(plan(session, 2), {}, async () => {
        await session.frequency(["окна"], ["wordstat_n"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(session.spending()).toMatchObject({ spentRub: 0.02, reservedRub: 0 });
    expect(session.spending().calls[0]).toMatchObject({ status: "failed", spentRub: 0.02 });
  });

  it("counts the quota of nested serp reports once", async () => {
    const { session } = await makeSession(
      fakeHandlers({ serp: () => json([{ keyword: "окна", region_wsn: 10 }]) }),
    );
    const estimate = session.estimate([{ method: "serp.report", requests: 2 }]);
    await session.runWithAllowance({ label: "serp_plan", params: {}, estimate }, {}, async () => {
      await session.serpReport({
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "a",
      });
      await session.serpReport({
        region: "yandex_msk",
        report: "report_keyword_info",
        keyword: "b",
      });
    });
    expect(session.spending().quotaRequests).toBe(2);
  });
});

describe("MutagenSession.serpReportCount", () => {
  const params = {
    region: "yandex_msk",
    report: "report_keyword_tailings",
    keyword: "окна",
  } as const;

  it("goes through the guard, counts the quota and caches the count", async () => {
    const { session, count, calls } = await makeSession(
      fakeHandlers({ serp: () => json({ count: 42 }) }),
    );
    const dry = await session.serpReportCount(params, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, estimate: { quotaRequests: 1, totalRub: 0 } });
    expect(calls).toHaveLength(0);
    const first = await session.serpReportCount(params);
    expect(first).toMatchObject({ dryRun: false, count: 42, fromCache: false });
    expect(calls[0]?.body).toMatchObject({ count: 1, keyword: "окна" });
    const second = await session.serpReportCount(params);
    expect(second).toMatchObject({ count: 42, fromCache: true });
    expect(count("serp.report")).toBe(1);
    expect(session.spending()).toMatchObject({ quotaRequests: 1, spentRub: 0 });
  });

  it("is allowed in free-only mode and reports 111", async () => {
    const { session } = await makeSession(fakeHandlers({}), { freeOnly: true });
    await expect(session.serpReportCount(params)).rejects.toMatchObject({ code: 111 });
  });
});
