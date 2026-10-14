import type { Estimate, PlannedCall } from "../budget/estimate.js";
import { BudgetError } from "../budget/guard.js";
import { isTaskPending, MutagenError, STALE_TASK_EN, validationError } from "../core/errors.js";
import { isSerpRegion, type SerpRegion } from "../core/regions.js";
import type { ExportColumn } from "../export/types.js";
import {
  DATA_SOURCE,
  type DataSource,
  type DryRunResult,
  type MutagenSession,
  type PaidCallOptions,
} from "../session.js";
import { estimateTable } from "../tables/lists.js";
import { toNumber } from "../tables/mass.js";
import type { ResultTable } from "../tables/types.js";
import { type PhraseInput, type PhraseItem, toPhraseItem } from "../text/phrases.js";

export type ScenarioOptions = PaidCallOptions;

export interface ScenarioDone<S> {
  source: DataSource;
  dryRun: false;
  table: ResultTable;
  summary: S;
  estimate: Estimate;
  warnings: string[];
  partial: boolean;
  /** A long step is still running at Mutagen; repeating the call is free. */
  processing: boolean;
  spentRub: number;
}

export interface ScenarioPlanned {
  source: DataSource;
  dryRun: true;
  table: ResultTable;
  summary: Record<string, unknown>;
  estimate: Estimate;
  warnings: string[];
  partial: false;
}

export type ScenarioResult<S> = ScenarioDone<S> | ScenarioPlanned;

export interface StepResult<S> {
  table: ResultTable;
  summary: S;
  warnings: string[];
  partial: boolean;
  processing?: boolean;
}

export interface ScenarioPlan {
  label: string;
  params: Record<string, unknown>;
  estimate: Estimate;
  summary: Record<string, unknown>;
  warnings: string[];
}

export const MAX_SEEDS = 20;
export const DEFAULT_SERP_REGION: SerpRegion = "yandex_msk";

export const str = (key: string, title: string): ExportColumn => ({ key, title, type: "string" });
export const num = (key: string, title: string): ExportColumn => ({ key, title, type: "number" });

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function nested(options: ScenarioOptions): PaidCallOptions {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(options.onWait ? { onWait: options.onWait } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    ...(options.noCache ? { noCache: true } : {}),
    ...(options.newTask ? { newTask: true } : {}),
  };
}

export function executed<T extends { dryRun: false }>(result: T | DryRunResult): T {
  if (result.dryRun) throw new Error("Nested scenario call returned a dry run");
  return result;
}

export function isOverAllowance(error: unknown): error is BudgetError {
  return error instanceof BudgetError && error.kind === "over_allowance";
}

export function needsSubscription(error: unknown): boolean {
  return error instanceof MutagenError && error.code === 111;
}

export function noData(error: unknown): boolean {
  return error instanceof MutagenError && error.code === 117;
}

/** Steps that end a scenario early with a partial result: no estimate left or a long task. */
export function isStop(error: unknown): error is BudgetError | MutagenError {
  return isOverAllowance(error) || isTaskPending(error);
}

export function stopWarning(step: string, error: BudgetError | MutagenError): string {
  if (isTaskPending(error)) {
    const stale = error.stale ? ` ${STALE_TASK_EN}` : "";
    const notes = error.warnings.length > 0 ? ` ${error.warnings.join(" ")}` : "";
    return `Шаг «${step}» еще считается у Мутагена, результат частичный: ${error.hintRu} Step "${step}" is still processing, the result is partial; repeat the same call later for free.${stale}${notes}`;
  }
  return `Смета исчерпана на шаге «${step}», результат частичный: ${error.hintRu} Approved estimate exhausted at step "${step}", the result is partial.`;
}

export function invalid(name: string, ru: string, en: string): MutagenError {
  return validationError(`Invalid ${name}: ${en}`, `${name}: ${ru}`, `${name}: ${en}`);
}

export function requireBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw invalid(
      "budgetRub",
      "укажите бюджет сценария в рублях, больше 0.",
      "set the scenario budget in RUB, above 0.",
    );
  }
  return value;
}

export function intOption(name: string, value: number | undefined, fallback: number, min = 0) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min) {
    throw invalid(name, `нужно целое число от ${min}.`, `expected an integer of ${min} or more.`);
  }
  return result;
}

export function numberOption(name: string, value: number | undefined, fallback = 0): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) {
    throw invalid(name, "нужно неотрицательное число.", "expected a non-negative number.");
  }
  return result;
}

export function serpRegionOf(value: string | undefined): SerpRegion {
  const region = value ?? DEFAULT_SERP_REGION;
  if (!isSerpRegion(region)) {
    throw invalid(
      "serpRegion",
      `неизвестный регион Мега-инструмента ${region}.`,
      `unknown Mega-tool region ${region}.`,
    );
  }
  return region;
}

export function seedList(seeds: readonly string[] | undefined, max = MAX_SEEDS): string[] {
  const list = unique((seeds ?? []).map((seed) => seed.trim().replace(/\s+/g, " ")));
  const result = list.filter((seed) => seed !== "");
  if (result.length === 0 || result.length > max) {
    throw invalid(
      "seeds",
      `нужно от 1 до ${max} фраз-маркеров, передано ${result.length}.`,
      `expected 1 to ${max} seed phrases, got ${result.length}.`,
    );
  }
  return result;
}

export function phraseItems(
  phrases: readonly PhraseInput[] | undefined,
  max: number,
): PhraseItem[] {
  const items = (phrases ?? [])
    .map(toPhraseItem)
    .map((item) => ({ ...item, phrase: item.phrase.trim() }))
    .filter((item) => item.phrase !== "");
  if (items.length === 0 || items.length > max) {
    throw invalid(
      "phrases",
      `нужно от 1 до ${max} фраз, передано ${items.length}.`,
      `expected 1 to ${max} phrases, got ${items.length}.`,
    );
  }
  return items;
}

export function frequencyOf(value: unknown): number | null {
  return toNumber(value);
}

export function costOf(session: MutagenSession, calls: readonly PlannedCall[]): number {
  return session.estimate(calls).totalKopecks;
}

/** Largest value in [0, max] whose cost fits; cost must not decrease as the value grows. */
export function largestFitting(max: number, fits: (value: number) => boolean): number {
  let low = 0;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The scenario budget, capped by what is left of the session budget. */
export function effectiveBudget(
  session: MutagenSession,
  budgetRub: number,
  warnings: string[],
): number {
  const budget = Math.round(budgetRub * 100);
  const remaining = Math.round(session.spending().remainingRub * 100);
  if (remaining < budget) {
    warnings.push(
      `Остаток бюджета сессии ${(remaining / 100).toFixed(2)} ₽ меньше бюджета сценария ${budgetRub.toFixed(2)} ₽: план рассчитан на остаток. The session budget left is below the scenario budget.`,
    );
    return remaining;
  }
  return budget;
}

/**
 * Shapes the plan by the scenario budget. Only when its exact cost (cache and paid pending tasks
 * are free) does not fit into the rest of the session budget, shapes it again by that rest: a
 * repeat of a plan whose tasks are already paid keeps the same plan.
 */
export async function shapeToBudget<S extends { notes: string[] }>(
  session: MutagenSession,
  budgetRub: number,
  warnings: string[],
  shape: (budgetKopecks: number) => S,
  cost: (shaped: S) => Promise<Estimate>,
): Promise<{ shaped: S; estimate: Estimate }> {
  const budget = Math.round(budgetRub * 100);
  let shaped = shape(budget);
  let estimate = await cost(shaped);
  const remaining = Math.round(session.spending().remainingRub * 100);
  if (estimate.totalKopecks > remaining && remaining < budget) {
    shaped = shape(effectiveBudget(session, budgetRub, warnings));
    estimate = await cost(shaped);
  }
  warnings.push(...shaped.notes);
  return { shaped, estimate };
}

export function overBudget(estimate: Estimate, budgetKopecks: number, step: string): BudgetError {
  const budget = (budgetKopecks / 100).toFixed(2);
  return new BudgetError({
    kind: "over_budget",
    estimate,
    remainingRub: budgetKopecks / 100,
    message: `Even ${step} does not fit into the budget of ${budget} RUB (estimate ${estimate.totalRub.toFixed(2)} RUB)`,
    hintRu: `Даже ${step} не укладывается в бюджет ${budget} ₽ (смета ${estimate.totalRub.toFixed(2)} ₽). Увеличьте budget_rub или уменьшите число маркеров и глубину.`,
    hintEn: `Even ${step} does not fit into the budget of ${budget} RUB (estimate ${estimate.totalRub.toFixed(2)} RUB). Raise budget_rub or use fewer seeds and a smaller depth.`,
  });
}

export async function runScenario<S>(
  session: MutagenSession,
  plan: ScenarioPlan,
  options: ScenarioOptions,
  run: () => Promise<StepResult<S>>,
): Promise<ScenarioResult<S>> {
  const { estimate } = plan;
  const result = await session.runWithAllowance(
    { label: plan.label, params: plan.params, estimate },
    { confirmToken: options.confirmToken, dryRun: options.dryRun },
    run,
  );
  if (result.dryRun) {
    return {
      source: DATA_SOURCE,
      dryRun: true,
      table: estimateTable(estimate),
      summary: plan.summary,
      estimate,
      warnings: plan.warnings,
      partial: false,
    };
  }
  const { value } = result;
  return {
    source: DATA_SOURCE,
    dryRun: false,
    table: value.table,
    summary: value.summary,
    estimate,
    warnings: unique([...plan.warnings, ...value.warnings, ...result.warnings]),
    partial: value.partial,
    processing: value.processing ?? false,
    spentRub: result.spentRub,
  };
}

/** Phrases without a frequency stay in the result: a filter cannot judge them. */
export function missingFrequency(count: number, filter: string): string {
  return `Частота не получена для ${count} фраз: фильтр ${filter} их не отсеял, проверьте вручную. Frequency missing for ${count} phrases, kept despite ${filter}.`;
}

export function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toLocaleUpperCase("ru") + rest.join("");
}
