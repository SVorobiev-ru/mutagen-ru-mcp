import { type Estimate, mergeEstimates, type PlannedCall } from "../budget/estimate.js";
import { isTaskPending } from "../core/errors.js";
import type { SerpRegion } from "../core/regions.js";
import type { FrequencyParser, ParserType, SerpReportParams, SerpRow } from "../core/types.js";
import {
  type DryRunResult,
  type MutagenSession,
  type ParserRunResult,
  type SerpReportResult,
  SINGLE_MAX_PHRASES,
} from "../session.js";
import { phraseKey as tableKey, UNRECOGNIZED_WARNING } from "../tables/mass.js";
import { frequencyTable, wordstatKeywordsTable } from "../tables/parser.js";
import type { ResultTable } from "../tables/types.js";
import {
  costOf,
  executed,
  frequencyOf,
  invalid,
  isStop,
  needsSubscription,
  nested,
  noData,
  type ScenarioOptions,
  stopWarning,
} from "./common.js";

export type CollectSource = "wordstat" | "serp" | "auto";

export const COLLECT_SOURCES: readonly CollectSource[] = ["wordstat", "serp", "auto"];

export interface CollectSpec {
  seeds: readonly string[];
  source: CollectSource;
  depth: 200 | 2000;
  region: string | undefined;
  serpRegion: SerpRegion;
  questions?: boolean;
}

export interface CollectedPhrase {
  phrase: string;
  frequency: number | null;
  seed: string;
}

export interface Collected {
  phrases: CollectedPhrase[];
  source: "wordstat" | "serp";
  warnings: string[];
  partial: boolean;
  processing: boolean;
}

export function sourceOf(value: string | undefined): CollectSource {
  const source = value ?? "auto";
  if (!(COLLECT_SOURCES as readonly string[]).includes(source)) {
    throw invalid("source", "допустимо wordstat, serp или auto.", "use wordstat, serp or auto.");
  }
  return source as CollectSource;
}

export function depthOf(value: number | undefined): 200 | 2000 {
  const depth = value ?? 200;
  if (depth !== 200 && depth !== 2000) {
    throw invalid("depth", "допустимо 200 или 2000.", "use 200 or 2000.");
  }
  return depth;
}

function wordstatParser(depth: 200 | 2000): ParserType {
  return depth === 2000 ? "wordstat_key" : "wordstat_key_50";
}

/** Upper bound of the collection: one call per seed, both sources for `auto`. */
export function collectCalls(
  session: MutagenSession,
  seeds: number,
  source: CollectSource,
  depth: 200 | 2000,
): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (seeds === 0) return calls;
  if (source !== "wordstat") calls.push({ method: "serp.report", requests: seeds });
  if (source !== "serp") {
    const one = session.parserCall(1, [wordstatParser(depth)]);
    calls.push(
      one.method === "parser.get"
        ? { ...one, phrases: seeds }
        : { method: "parser.mass.new", parsers: [wordstatParser(depth)], phrases: seeds },
    );
  }
  return calls;
}

/** Upper bound of one frequency call for up to `phrases` phrases. */
export function frequencyCall(
  session: MutagenSession,
  phrases: number,
  types: readonly FrequencyParser[],
): PlannedCall {
  const full = session.parserCall(phrases, types);
  const small = session.parserCall(Math.min(phrases, SINGLE_MAX_PHRASES), types);
  return costOf(session, [small]) > costOf(session, [full]) ? small : full;
}

export function isRawTable(table: ResultTable): boolean {
  return table.columns.some((column) => column.key === "raw");
}

function serpBase(row: SerpRow, region: SerpRegion): number | null {
  const regional = frequencyOf(row.region_wsn);
  const world = frequencyOf(row.world_wsn);
  return region === "yandex_ru" ? (world ?? regional) : (regional ?? world);
}

export function serpPhrases(rows: readonly SerpRow[], region: SerpRegion, seed: string) {
  const result: CollectedPhrase[] = [];
  for (const row of rows) {
    if (typeof row.keyword !== "string" || row.keyword.trim() === "") continue;
    result.push({ phrase: row.keyword.trim(), frequency: serpBase(row, region), seed });
  }
  return result;
}

async function fromWordstat(
  session: MutagenSession,
  seed: string,
  spec: CollectSpec,
  options: ScenarioOptions,
  warnings: string[],
): Promise<CollectedPhrase[]> {
  const result = executed<ParserRunResult>(
    await session.wordstatKeywords(seed, spec.depth, spec.region, nested(options)),
  );
  warnings.push(...(result.warnings ?? []));
  const table = wordstatKeywordsTable(result);
  if (isRawTable(table)) {
    warnings.push(`«${seed}»: ${UNRECOGNIZED_WARNING}`);
    return [];
  }
  return table.rows
    .filter((row) => typeof row.phrase === "string")
    .map((row) => ({ phrase: String(row.phrase), frequency: frequencyOf(row.frequency), seed }));
}

function serpParams(seed: string, spec: CollectSpec): SerpReportParams {
  return {
    region: spec.serpRegion,
    report: "report_keyword_tailings",
    keyword: seed,
    limit: spec.depth,
    ...(spec.questions ? { filter: [{ column: "has_question", filter_type: "is", val: 1 }] } : {}),
  } as unknown as SerpReportParams;
}

async function fromSerp(
  session: MutagenSession,
  seed: string,
  spec: CollectSpec,
  options: ScenarioOptions,
  warnings: string[],
): Promise<CollectedPhrase[]> {
  const result = executed<SerpReportResult>(
    await session.serpReport(serpParams(seed, spec), nested(options)),
  );
  warnings.push(...(result.warnings ?? []));
  return serpPhrases(result.rows, spec.serpRegion, seed);
}

export interface CollectEstimate {
  estimate: Estimate;
  /** Every seed is in the cache: {@link collect} makes no API requests. */
  cached: boolean;
}

/** The cost of {@link collect} like dry_run: cached seeds and paid pending tasks are free. */
export async function collectEstimate(
  session: MutagenSession,
  spec: CollectSpec,
  options: ScenarioOptions,
): Promise<CollectEstimate> {
  const dry = { ...nested(options), dryRun: true };
  const serp =
    spec.source === "wordstat"
      ? []
      : await Promise.all(
          spec.seeds.map((seed) => session.serpReport(serpParams(seed, spec), dry)),
        );
  const serpCached = serp.length > 0 && serp.every((result) => !result.dryRun);
  const wordstat =
    spec.source === "serp" || (spec.source === "auto" && serpCached)
      ? []
      : await Promise.all(
          spec.seeds.map(
            (seed) =>
              session.wordstatKeywords(seed, spec.depth, spec.region, dry) as Promise<DryRunResult>,
          ),
        );
  const cached =
    spec.source === "wordstat"
      ? wordstat.length > 0 && wordstat.every((result) => result.cached === true)
      : serpCached;
  return {
    estimate: mergeEstimates([...serp, ...wordstat].map((result) => result.estimate)),
    cached,
  };
}

/**
 * Collects phrases for every seed. `auto` tries the Mega-tool first and switches to Wordstat
 * when the first request answers 111 (no subscription).
 */
export async function collect(
  session: MutagenSession,
  spec: CollectSpec,
  options: ScenarioOptions,
): Promise<Collected> {
  const warnings: string[] = [];
  let partial = false;
  let processing = false;
  let source: "wordstat" | "serp" = spec.source === "wordstat" ? "wordstat" : "serp";
  const run = (seed: string) =>
    source === "serp"
      ? fromSerp(session, seed, spec, options, warnings)
      : fromWordstat(session, seed, spec, options, warnings);
  const settled: PromiseSettledResult<CollectedPhrase[]>[] = [];
  let rest = [...spec.seeds];
  if (spec.source === "auto" && rest.length > 0) {
    const [first, ...others] = rest as [string, ...string[]];
    try {
      settled.push({ status: "fulfilled", value: await run(first) });
      rest = others;
    } catch (error) {
      if (!needsSubscription(error)) {
        settled.push({ status: "rejected", reason: error });
        rest = others;
      } else {
        source = "wordstat";
        warnings.push(
          "Подписки на Мега-инструмент нет (ошибка 111): подсбор переключен на Вордстат. No Mega-tool subscription: switched to Wordstat.",
        );
      }
    }
  }
  settled.push(...(await Promise.allSettled(rest.map(run))));
  const phrases: CollectedPhrase[] = [];
  let failure: unknown;
  for (const [index, item] of settled.entries()) {
    if (item.status === "fulfilled") {
      phrases.push(...item.value);
      continue;
    }
    const error: unknown = item.reason;
    if (isStop(error)) {
      if (!partial) warnings.push(stopWarning("подсбор фраз", error));
      partial = true;
      processing ||= isTaskPending(error);
    } else if (noData(error)) {
      warnings.push(`Нет данных по маркеру «${spec.seeds[index]}» (117). No data for the seed.`);
    } else {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return { phrases, source, warnings, partial, processing };
}

export interface FrequencyValues {
  values: Map<string, Partial<Record<FrequencyParser, number | null>>>;
  recognized: boolean;
  warnings: string[];
}

export function frequencyKey(phrase: string): string {
  return tableKey(phrase);
}

/** Frequencies through src/tables; an unrecognized answer leaves the phrases without them. */
export async function frequencies(
  session: MutagenSession,
  phrases: readonly string[],
  types: readonly FrequencyParser[],
  region: string | undefined,
  options: ScenarioOptions,
): Promise<FrequencyValues> {
  const values: FrequencyValues["values"] = new Map();
  if (phrases.length === 0 || types.length === 0) return { values, recognized: true, warnings: [] };
  const result = executed<ParserRunResult>(
    await session.frequency(phrases, types, region, nested(options)),
  );
  const warnings = [...(result.warnings ?? [])];
  const table = frequencyTable(result);
  if (isRawTable(table)) {
    warnings.push(`Частоты не распознаны, фразы оставлены без частоты. ${UNRECOGNIZED_WARNING}`);
    return { values, recognized: false, warnings };
  }
  for (const row of table.rows) {
    const entry: Partial<Record<FrequencyParser, number | null>> = {};
    for (const type of types) entry[type] = frequencyOf(row[type]);
    values.set(frequencyKey(String(row.phrase)), entry);
  }
  return { values, recognized: true, warnings };
}
