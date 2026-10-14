import { mergeEstimates, type PlannedCall } from "../budget/estimate.js";
import { isTaskPending } from "../core/errors.js";
import { FREQUENCY_PARSERS, type FrequencyParser } from "../core/types.js";
import { MAX_MASS_KEYS, regionId } from "../core/validate.js";
import type { CompetitionResult, MutagenSession } from "../session.js";
import { FREQUENCY_TITLES } from "../tables/parser.js";
import { table } from "../tables/types.js";
import { clusterLexical } from "../text/cluster.js";
import { removeDuplicates } from "../text/duplicates.js";
import { findMinusCandidates, MINUS_CATEGORIES, type MinusCategory } from "../text/minus.js";
import { normalizePhrase, normalizeText } from "../text/normalize.js";
import { compareText, type PhraseInput, phraseKey } from "../text/phrases.js";
import { stem } from "../text/stem.js";
import { filterByMask } from "../text/tools.js";
import {
  type CollectedPhrase,
  type CollectSource,
  collect,
  collectCalls,
  collectEstimate,
  depthOf,
  frequencies,
  frequencyCall,
  frequencyKey,
  sourceOf,
} from "./collect.js";
import {
  costOf,
  executed,
  intOption,
  invalid,
  isStop,
  largestFitting,
  MAX_SEEDS,
  missingFrequency,
  nested,
  num,
  numberOption,
  overBudget,
  phraseItems,
  requireBudget,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  seedList,
  serpRegionOf,
  shapeToBudget,
  stopWarning,
  str,
  unique,
} from "./common.js";

export const DEFAULT_MAX_PHRASES = 500;
export const DEFAULT_WORDSTAT_REGION = "225";

export interface BuildCoreParams {
  seeds: readonly string[];
  budgetRub: number;
  region?: string | undefined;
  serpRegion?: string | undefined;
  source?: CollectSource | undefined;
  depth?: 200 | 2000 | undefined;
  minFrequency?: number | undefined;
  exactTypes?: readonly FrequencyParser[] | undefined;
  minExact?: number | undefined;
  stopWords?: readonly string[] | undefined;
  excludeMinus?: boolean | undefined;
  /** Categories of `MINUS_CATEGORIES` to drop, default {@link SEO_JUNK_CATEGORIES}. */
  excludeCategories?: readonly MinusCategory[] | undefined;
  maxPhrases?: number | undefined;
  competitionTop?: number | undefined;
}

export interface BuildCoreSummary {
  source: "wordstat" | "serp";
  seeds: string[];
  collected: number;
  removed: {
    duplicates: number;
    stopWords: number;
    minus: number;
    implicitDuplicates: number;
    minFrequency: number;
    overLimit: number;
    minExact: number;
  };
  phrases: number;
  clusters: number;
  maxPhrases: number;
  competitionTop: number;
  minusWords: string[];
  frequenciesRecognized: boolean;
}

interface CoreRow {
  phrase: string;
  base: number | null;
  seed: string;
  exact: Partial<Record<FrequencyParser, number | null>>;
  competition?: number | null;
  cluster?: string;
}

function exactTypesOf(value: readonly FrequencyParser[] | undefined): FrequencyParser[] {
  const types = unique(value ?? ["wordstat_qs"]) as FrequencyParser[];
  for (const type of types) {
    if (!(FREQUENCY_PARSERS as readonly string[]).includes(type)) {
      throw invalid(
        "exactTypes",
        `неизвестный вид частотности ${type}.`,
        `unknown frequency type ${type}.`,
      );
    }
  }
  return types;
}

function categoriesOf(value: readonly MinusCategory[] | undefined): MinusCategory[] {
  const categories = unique(value ?? SEO_JUNK_CATEGORIES) as MinusCategory[];
  for (const category of categories) {
    if (!Object.hasOwn(MINUS_CATEGORIES, category)) {
      throw invalid(
        "excludeCategories",
        `неизвестная категория ${category}; допустимо ${Object.keys(MINUS_CATEGORIES).join(", ")}.`,
        `unknown category ${category}; use ${Object.keys(MINUS_CATEGORIES).join(", ")}.`,
      );
    }
  }
  return categories;
}

function byBase(a: { phrase: string; base: number | null }, b: typeof a): number {
  return (
    (b.base ?? -1) - (a.base ?? -1) ||
    a.phrase.length - b.phrase.length ||
    compareText(a.phrase, b.phrase)
  );
}

/** Explicit duplicates after normalization: the first seed, the highest frequency. */
function mergeCollected(phrases: readonly CollectedPhrase[]): CoreRow[] {
  const rows = new Map<string, CoreRow>();
  for (const item of phrases) {
    const text = normalizeText(item.phrase);
    if (text === "") continue;
    const current = rows.get(text);
    if (current === undefined) {
      rows.set(text, { phrase: item.phrase, base: item.frequency, seed: item.seed, exact: {} });
    } else if ((item.frequency ?? -1) > (current.base ?? -1)) {
      current.base = item.frequency;
    }
  }
  return [...rows.values()];
}

function withoutStopWords<T extends { phrase: string }>(rows: T[], stopWords: readonly string[]) {
  if (stopWords.length === 0) return rows;
  const kept = new Set(
    filterByMask(
      rows.map((row) => row.phrase),
      { exclude: stopWords },
    ),
  );
  return rows.filter((row) => kept.has(row.phrase));
}

export const SEO_JUNK_CATEGORIES: readonly MinusCategory[] = [
  "download",
  "study",
  "job",
  "used",
  "entertainment",
];

/** Drops phrases of the categories; disputed words stay unless the whole category is disputed. */
function withoutMinus<T extends { phrase: string; base: number | null }>(
  rows: T[],
  targetWords: readonly string[],
  categories: readonly MinusCategory[],
): { rows: T[]; words: string[] } {
  const candidates = findMinusCandidates(
    rows.map((row) => ({ phrase: row.phrase, frequency: row.base ?? 0 })),
    { targetWords, categories },
  ).filter((candidate) => !candidate.disputed || MINUS_CATEGORIES[candidate.category].disputed);
  if (candidates.length === 0) return { rows, words: [] };
  const kept = rows.filter((row) => {
    const stems = new Set(normalizePhrase(row.phrase).words.map((word) => stem(word)));
    return !candidates.some((candidate) => candidate.stems.every((item) => stems.has(item)));
  });
  return { rows: kept, words: candidates.map((candidate) => candidate.word) };
}

/** Implicit duplicates: keeps the most frequent form of every group. */
function withoutImplicit<T extends { phrase: string; base: number | null }>(rows: T[]): T[] {
  const byPhrase = new Map(rows.map((row) => [row.phrase, row]));
  return removeDuplicates(rows.map((row) => ({ phrase: row.phrase, frequency: row.base ?? 0 })))
    .map((item) => byPhrase.get(item.phrase))
    .filter((row): row is T => row !== undefined);
}

function clusterRows<T extends { phrase: string; cluster?: string }>(
  rows: readonly T[],
  frequency: (row: T) => number,
): { rows: T[]; clusters: number } {
  const byPhrase = new Map(rows.map((row) => [row.phrase, row]));
  const clusters = clusterLexical(
    rows.map((row) => ({ phrase: row.phrase, frequency: frequency(row) })),
    { mode: "soft" },
  );
  const ordered: T[] = [];
  for (const cluster of clusters) {
    for (const item of cluster.phrases) {
      const row = byPhrase.get(item.phrase);
      if (row === undefined) continue;
      row.cluster = cluster.name;
      ordered.push(row);
    }
  }
  return { rows: ordered, clusters: clusters.length };
}

interface RowFilters {
  seeds: readonly string[];
  stopWords: readonly string[];
  excludeMinus: boolean;
  excludeCategories: readonly MinusCategory[];
  minFrequency: number;
}

/** Cleanup and the top of the collected phrases; the same input always gives the same rows. */
function selectRows(phrases: readonly CollectedPhrase[], filters: RowFilters, maxPhrases: number) {
  const merged = mergeCollected(phrases);
  const cleaned = withoutStopWords(merged, filters.stopWords);
  const minus = filters.excludeMinus
    ? withoutMinus(cleaned, filters.seeds, filters.excludeCategories)
    : { rows: cleaned, words: [] as string[] };
  const implicit = withoutImplicit(minus.rows);
  const frequent = implicit.filter((row) => row.base === null || row.base >= filters.minFrequency);
  const top = [...frequent].sort(byBase).slice(0, maxPhrases);
  return { merged, cleaned, minus, implicit, frequent, top };
}

export async function buildCore(
  session: MutagenSession,
  params: BuildCoreParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<BuildCoreSummary>> {
  const seeds = seedList(params.seeds);
  const source = sourceOf(params.source);
  const depth = depthOf(params.depth);
  const region = regionId(params.region ?? DEFAULT_WORDSTAT_REGION);
  const serpRegion = serpRegionOf(params.serpRegion);
  const exactTypes = exactTypesOf(params.exactTypes);
  const minFrequency = numberOption("minFrequency", params.minFrequency);
  const minExact = numberOption("minExact", params.minExact);
  const stopWords = (params.stopWords ?? []).map((word) => word.trim()).filter(Boolean);
  const excludeMinus = params.excludeMinus ?? true;
  const excludeCategories = excludeMinus ? categoriesOf(params.excludeCategories) : [];
  const requested = Math.min(
    intOption("maxPhrases", params.maxPhrases, DEFAULT_MAX_PHRASES, 1),
    MAX_MASS_KEYS,
  );
  const requestedTop = Math.min(intOption("competitionTop", params.competitionTop, 0), requested);
  const warnings: string[] = [];
  const budgetRub = requireBudget(params.budgetRub);
  const spec = { seeds, source, depth, region, serpRegion };
  const filters = { seeds, stopWords, excludeMinus, excludeCategories, minFrequency };

  const collectPlan = collectCalls(session, seeds.length, source, depth);
  const calls = (phrases: number, top: number): PlannedCall[] => [
    ...collectPlan,
    ...(phrases > 0 && exactTypes.length > 0 ? [frequencyCall(session, phrases, exactTypes)] : []),
    ...(top > 0 ? [{ method: "check_key.new" as const, phrases: top }] : []),
  ];
  const shape = (budget: number) => {
    const fits = (phrases: number, top: number) => costOf(session, calls(phrases, top)) <= budget;
    if (!fits(0, 0)) throw overBudget(session.estimate(collectPlan), budget, "подсбор фраз");
    if (fits(requested, requestedTop)) {
      return { maxPhrases: requested, competitionTop: requestedTop, notes: [] };
    }
    const full = session.estimate(calls(requested, requestedTop));
    const maxPhrases = largestFitting(requested, (value) => fits(value, 0));
    if (maxPhrases === 0) {
      throw overBudget(session.estimate(calls(1, 0)), budget, "подсбор и частоты одной фразы");
    }
    const competitionTop = largestFitting(Math.min(requestedTop, maxPhrases), (value) =>
      fits(maxPhrases, value),
    );
    const note = `Полная смета ${full.totalRub.toFixed(2)} ₽ больше бюджета ${(budget / 100).toFixed(2)} ₽, план уменьшен: ${[
      `max_phrases ${requested} → ${maxPhrases}`,
      ...(requestedTop > 0 ? [`competition_top ${requestedTop} → ${competitionTop}`] : []),
    ].join(", ")}. Reduced to fit the budget.`;
    return { maxPhrases, competitionTop, notes: [note] };
  };
  const collecting = await collectEstimate(session, spec, options);
  const cached = collecting.cached ? (await collect(session, spec, options)).phrases : undefined;
  const cost = async ({ maxPhrases, competitionTop }: ReturnType<typeof shape>) => {
    const parts = [collecting.estimate];
    let top = competitionTop;
    if (cached) {
      const phrases = selectRows(cached, filters, maxPhrases).top.map((row) => row.phrase);
      top = Math.min(top, phrases.length);
      if (phrases.length > 0 && exactTypes.length > 0) {
        const dry = { ...nested(options), dryRun: true };
        parts.push((await session.frequency(phrases, exactTypes, region, dry)).estimate);
      }
    } else {
      parts.push(session.estimate(calls(maxPhrases, 0).slice(collectPlan.length)));
    }
    parts.push(session.estimate(calls(0, top).slice(collectPlan.length)));
    return mergeEstimates(parts);
  };
  const { shaped, estimate } = await shapeToBudget(session, budgetRub, warnings, shape, cost);
  const { maxPhrases, competitionTop } = shaped;
  const settings = {
    seeds,
    source,
    depth,
    region,
    serpRegion,
    exactTypes,
    minFrequency,
    minExact,
    stopWords,
    excludeMinus,
    excludeCategories,
    maxPhrases,
    competitionTop,
  };

  return runScenario(
    session,
    { label: "build_core", params: settings, estimate, summary: settings, warnings },
    options,
    async () => {
      const notes: string[] = [];
      const collected = await collect(
        session,
        { seeds, source, depth, region, serpRegion },
        options,
      );
      notes.push(...collected.warnings);
      let partial = collected.partial;
      let stopped = collected.partial;
      let processing = collected.processing;

      const { merged, cleaned, minus, implicit, frequent, top } = selectRows(
        collected.phrases,
        filters,
        maxPhrases,
      );
      if (minFrequency > 0) {
        const unknown = frequent.filter((row) => row.base === null).length;
        if (unknown > 0) notes.push(missingFrequency(unknown, "min_frequency"));
      }

      let recognized = true;
      if (!stopped && exactTypes.length > 0 && top.length > 0) {
        try {
          const found = await frequencies(
            session,
            top.map((row) => row.phrase),
            exactTypes,
            region,
            options,
          );
          notes.push(...found.warnings);
          recognized = found.recognized;
          for (const row of top) row.exact = found.values.get(frequencyKey(row.phrase)) ?? {};
        } catch (error) {
          if (!isStop(error)) throw error;
          notes.push(stopWarning("точные частоты", error));
          partial = stopped = true;
          processing ||= isTaskPending(error);
        }
      }
      const first = exactTypes[0];
      const exactOf = (row: CoreRow) => (first === undefined ? null : (row.exact[first] ?? null));
      const kept =
        minExact > 0
          ? top.filter((row) => {
              const value = exactOf(row);
              return value === null || value >= minExact;
            })
          : top;
      if (minExact > 0) {
        const unknown = kept.filter((row) => exactOf(row) === null).length;
        if (unknown > 0) notes.push(missingFrequency(unknown, "min_exact"));
      }

      const checkCount = Math.min(competitionTop, kept.length);
      if (checkCount > 0 && !stopped) {
        const checked = [...kept]
          .sort(
            (a, b) => (exactOf(b) ?? b.base ?? -1) - (exactOf(a) ?? a.base ?? -1) || byBase(a, b),
          )
          .slice(0, checkCount);
        try {
          const result = executed<CompetitionResult>(
            await session.competition(
              checked.map((row) => row.phrase),
              nested(options),
            ),
          );
          notes.push(...(result.warnings ?? []));
          const strong = new Map(result.results.map((item) => [item.phrase, item.result.strong]));
          for (const row of checked) row.competition = strong.get(row.phrase) ?? null;
        } catch (error) {
          if (!isStop(error)) throw error;
          notes.push(stopWarning("конкуренция", error));
          partial = true;
          processing ||= isTaskPending(error);
        }
      }

      const clustered = clusterRows(kept, (row) => exactOf(row) ?? row.base ?? 0);
      const columns = [
        str("phrase", "Фраза"),
        num("base", "Базовая частота"),
        ...exactTypes.map((type) => num(type, FREQUENCY_TITLES[type])),
        ...(competitionTop > 0 ? [num("competition", "Конкуренция (0–25)")] : []),
        str("cluster", "Кластер"),
        str("seed", "Маркер"),
      ];
      const rows = clustered.rows.map((row) => ({
        phrase: row.phrase,
        base: row.base,
        ...Object.fromEntries(exactTypes.map((type) => [type, row.exact[type] ?? null])),
        ...(competitionTop > 0 ? { competition: row.competition ?? null } : {}),
        cluster: row.cluster ?? row.phrase,
        seed: row.seed,
      }));
      return {
        table: table(columns, rows, { query: seeds.join(", "), region }),
        summary: {
          source: collected.source,
          seeds,
          collected: collected.phrases.length,
          removed: {
            duplicates: collected.phrases.length - merged.length,
            stopWords: merged.length - cleaned.length,
            minus: cleaned.length - minus.rows.length,
            implicitDuplicates: minus.rows.length - implicit.length,
            minFrequency: implicit.length - frequent.length,
            overLimit: frequent.length - top.length,
            minExact: top.length - kept.length,
          },
          phrases: rows.length,
          clusters: clustered.clusters,
          maxPhrases,
          competitionTop,
          minusWords: minus.words,
          frequenciesRecognized: recognized,
        },
        warnings: notes,
        partial,
        processing,
      };
    },
  );
}

export interface ExpandCoreParams {
  phrases: readonly PhraseInput[];
  budgetRub: number;
  seeds?: readonly string[] | undefined;
  source?: CollectSource | undefined;
  depth?: 200 | 2000 | undefined;
  region?: string | undefined;
  serpRegion?: string | undefined;
  maxNew?: number | undefined;
}

export interface ExpandCoreSummary {
  source: "wordstat" | "serp";
  seeds: string[];
  collected: number;
  known: number;
  newPhrases: number;
  clusters: number;
}

export async function expandCore(
  session: MutagenSession,
  params: ExpandCoreParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<ExpandCoreSummary>> {
  const core = phraseItems(params.phrases, MAX_MASS_KEYS);
  const source = sourceOf(params.source);
  const depth = depthOf(params.depth);
  const region = regionId(params.region ?? DEFAULT_WORDSTAT_REGION);
  const serpRegion = serpRegionOf(params.serpRegion);
  const maxNew = intOption("maxNew", params.maxNew, DEFAULT_MAX_PHRASES, 1);
  const warnings: string[] = [];
  const candidates =
    params.seeds === undefined
      ? clusterLexical(core, { mode: "soft" })
          .slice(0, MAX_SEEDS)
          .map((cluster) => cluster.name.trim())
      : seedList(params.seeds);
  const shape = (budget: number) => {
    const fits = (count: number) =>
      costOf(session, collectCalls(session, count, source, depth)) <= budget;
    if (fits(candidates.length)) return { seeds: candidates, notes: [] };
    const count = largestFitting(candidates.length, fits);
    if (count === 0) {
      throw overBudget(
        session.estimate(collectCalls(session, 1, source, depth)),
        budget,
        "подсбор по одному маркеру",
      );
    }
    return {
      seeds: candidates.slice(0, count),
      notes: [
        `Бюджета хватает на ${count} маркеров из ${candidates.length}: взяты самые частотные. Only ${count} seeds fit the budget.`,
      ],
    };
  };
  const { shaped, estimate } = await shapeToBudget(
    session,
    requireBudget(params.budgetRub),
    warnings,
    shape,
    async ({ seeds }) =>
      (await collectEstimate(session, { seeds, source, depth, region, serpRegion }, options))
        .estimate,
  );
  const { seeds } = shaped;
  const settings = { seeds, source, depth, region, serpRegion, maxNew, core: core.length };

  return runScenario(
    session,
    {
      label: "expand_core",
      params: { ...settings, coreKeys: core.map((item) => phraseKey(item.phrase)).sort() },
      estimate,
      summary: settings,
      warnings,
    },
    options,
    async () => {
      const collected = await collect(
        session,
        { seeds, source, depth, region, serpRegion },
        options,
      );
      const known = new Set(core.map((item) => phraseKey(item.phrase)));
      const merged = mergeCollected(collected.phrases);
      const fresh = merged.filter((row) => !known.has(phraseKey(row.phrase)));
      const added = withoutImplicit(fresh).sort(byBase).slice(0, maxNew);
      const newPhrases = new Set(added.map((row) => row.phrase));
      const clustered = clusterRows(
        [
          ...core.map((item) => ({ phrase: item.phrase, base: item.frequency ?? null, seed: "" })),
          ...added.map((row) => ({ phrase: row.phrase, base: row.base, seed: row.seed })),
        ] as { phrase: string; base: number | null; seed: string; cluster?: string }[],
        (row) => row.base ?? 0,
      );
      const rows = clustered.rows
        .filter((row) => newPhrases.has(row.phrase) && row.seed !== "")
        .map((row) => ({
          phrase: row.phrase,
          frequency: row.base,
          cluster: row.cluster ?? row.phrase,
          seed: row.seed,
        }));
      return {
        table: table(
          [
            str("phrase", "Фраза"),
            num("frequency", "Базовая частота"),
            str("cluster", "Кластер"),
            str("seed", "Маркер"),
          ],
          rows,
          { query: seeds.join(", "), region },
        ),
        summary: {
          source: collected.source,
          seeds,
          collected: collected.phrases.length,
          known: merged.length - fresh.length,
          newPhrases: rows.length,
          clusters: new Set(rows.map((row) => row.cluster)).size,
        },
        warnings: collected.warnings,
        partial: collected.partial,
        processing: collected.processing,
      };
    },
  );
}
