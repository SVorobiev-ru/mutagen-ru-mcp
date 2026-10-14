import { MAX_MASS_KEYS, regionId } from "../core/validate.js";
import type { MutagenSession } from "../session.js";
import { table } from "../tables/types.js";
import { findMinusCandidates, type MinusCandidate } from "../text/minus.js";
import { tokenize } from "../text/normalize.js";
import type { PhraseInput, PhraseItem } from "../text/phrases.js";
import { isStopword } from "../text/stopwords.js";
import { collect, collectEstimate, depthOf } from "./collect.js";
import {
  effectiveBudget,
  intOption,
  invalid,
  num,
  overBudget,
  phraseItems,
  requireBudget,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  seedList,
  serpRegionOf,
  str,
  unique,
} from "./common.js";
import { DEFAULT_WORDSTAT_REGION } from "./core.js";

export interface MinusWordsParams {
  seeds?: readonly string[] | undefined;
  phrases?: readonly PhraseInput[] | undefined;
  depth?: 200 | 2000 | undefined;
  region?: string | undefined;
  targetWords?: readonly string[] | undefined;
  budgetRub?: number | undefined;
  includeDisputed?: boolean | undefined;
  examples?: number | undefined;
}

export interface MinusWordsSummary {
  phrases: number;
  candidates: number;
  direct: string;
  seeds: string[];
}

/** «-слово -слово» for Yandex Direct; every significant word of a multi-word marker. */
export function directMinusLine(candidates: readonly MinusCandidate[]): string {
  const words = candidates.flatMap((candidate) => {
    const tokens = tokenize(candidate.word);
    const significant = tokens.filter((token) => !isStopword(token));
    return significant.length > 0 ? significant : tokens;
  });
  return unique(words)
    .map((word) => `-${word}`)
    .join(" ");
}

/** True when the call never reaches the API: phrases only, no seeds to collect. */
export function minusWordsIsLocal(params: MinusWordsParams): boolean {
  return !params.seeds?.length;
}

export async function minusWords(
  session: MutagenSession,
  params: MinusWordsParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<MinusWordsSummary>> {
  if (!params.seeds?.length && !params.phrases?.length) {
    throw invalid("seeds", "передайте seeds или phrases.", "pass seeds or phrases.");
  }
  const seeds = params.seeds?.length ? seedList(params.seeds) : [];
  const given: PhraseItem[] = params.phrases?.length
    ? phraseItems(params.phrases, MAX_MASS_KEYS)
    : [];
  const depth = depthOf(params.depth);
  const region = regionId(params.region ?? DEFAULT_WORDSTAT_REGION);
  const examples = intOption("examples", params.examples, 3);
  const includeDisputed = params.includeDisputed ?? false;
  const targetWords = params.targetWords ?? seeds;
  const warnings: string[] = [];
  const estimate =
    seeds.length > 0
      ? (
          await collectEstimate(
            session,
            { seeds, source: "wordstat", depth, region, serpRegion: serpRegionOf(undefined) },
            options,
          )
        ).estimate
      : session.estimate([]);
  if (seeds.length > 0 && params.budgetRub !== undefined) {
    const budget = effectiveBudget(session, requireBudget(params.budgetRub), warnings);
    if (estimate.totalKopecks > budget) throw overBudget(estimate, budget, "подсбор фраз");
  }
  const settings = {
    seeds,
    depth,
    region,
    targetWords,
    includeDisputed,
    phrases: given.map((item) => [item.phrase, item.frequency ?? null]),
  };
  return runScenario(
    session,
    {
      label: "minus_words",
      params: settings,
      estimate,
      summary: { seeds, depth, region, phrases: given.length },
      warnings,
    },
    options,
    async () => {
      const collected =
        seeds.length > 0
          ? await collect(
              session,
              { seeds, source: "wordstat", depth, region, serpRegion: serpRegionOf(undefined) },
              options,
            )
          : { phrases: [], warnings: [], partial: false, processing: false };
      const phrases: PhraseItem[] = [
        ...given,
        ...collected.phrases.map((item) => ({
          phrase: item.phrase,
          ...(item.frequency === null ? {} : { frequency: item.frequency }),
        })),
      ];
      const candidates = findMinusCandidates(phrases, { targetWords, examples });
      const direct = directMinusLine(
        candidates.filter((candidate) => includeDisputed || !candidate.disputed),
      );
      return {
        table: table(
          [
            str("word", "Слово"),
            str("category", "Категория"),
            { key: "disputed", title: "Спорно", type: "boolean" },
            num("phrases", "Фраз"),
            num("frequency", "Сумма частот"),
            str("examples", "Примеры"),
          ],
          candidates.map((candidate) => ({
            word: candidate.word,
            category: candidate.categoryTitle,
            disputed: candidate.disputed,
            phrases: candidate.phrases,
            frequency: candidate.frequency,
            examples: candidate.examples.join("; "),
          })),
          { query: seeds.join(", ") },
        ),
        summary: { phrases: phrases.length, candidates: candidates.length, direct, seeds },
        warnings: collected.warnings,
        partial: collected.partial,
        processing: collected.processing,
      };
    },
  );
}
