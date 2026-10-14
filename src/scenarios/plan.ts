import { MAX_MASS_KEYS, regionId } from "../core/validate.js";
import type { MutagenSession } from "../session.js";
import { table } from "../tables/types.js";
import { clusterLexical } from "../text/cluster.js";
import { normalizeText } from "../text/normalize.js";
import type { PhraseInput, PhraseItem } from "../text/phrases.js";
import { detectQuestion, findQuestions } from "../text/questions.js";
import { type CollectSource, collect, collectEstimate, depthOf, sourceOf } from "./collect.js";
import {
  capitalize,
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
} from "./common.js";
import { DEFAULT_WORDSTAT_REGION } from "./core.js";

export const MAX_SUBQUESTIONS = 10;

export interface ContentPlanParams {
  seeds?: readonly string[] | undefined;
  phrases?: readonly PhraseInput[] | undefined;
  source?: CollectSource | undefined;
  budgetRub?: number | undefined;
  depth?: 200 | 2000 | undefined;
  region?: string | undefined;
  serpRegion?: string | undefined;
  maxTopics?: number | undefined;
}

export interface ContentPlanSummary {
  source: "wordstat" | "serp" | "input";
  questions: number;
  topics: number;
}

interface Question extends PhraseItem {
  type: string;
  marker: string;
}

function topicTitle(phrase: string): string {
  const text = capitalize(normalizeText(phrase));
  return text.endsWith("?") ? text : `${text}?`;
}

/** True when the call never reaches the API: phrases only, no seeds to collect. */
export function contentPlanIsLocal(params: ContentPlanParams): boolean {
  return !params.seeds?.length;
}

export async function contentPlan(
  session: MutagenSession,
  params: ContentPlanParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<ContentPlanSummary>> {
  if (!params.seeds?.length && !params.phrases?.length) {
    throw invalid("seeds", "передайте seeds или phrases.", "pass seeds or phrases.");
  }
  const seeds = params.seeds?.length ? seedList(params.seeds) : [];
  const given = params.phrases?.length ? phraseItems(params.phrases, MAX_MASS_KEYS) : [];
  const source = sourceOf(params.source);
  const depth = depthOf(params.depth);
  const region = regionId(params.region ?? DEFAULT_WORDSTAT_REGION);
  const serpRegion = serpRegionOf(params.serpRegion);
  const maxTopics = intOption("maxTopics", params.maxTopics, Number.MAX_SAFE_INTEGER, 1);
  const warnings: string[] = [];
  const estimate =
    seeds.length > 0
      ? (await collectEstimate(session, { seeds, source, depth, region, serpRegion }, options))
          .estimate
      : session.estimate([]);
  if (seeds.length > 0) {
    const budget = effectiveBudget(session, requireBudget(params.budgetRub), warnings);
    if (estimate.totalKopecks > budget) throw overBudget(estimate, budget, "подсбор вопросов");
  }
  const settings = {
    seeds,
    source,
    depth,
    region,
    serpRegion,
    maxTopics,
    phrases: given.map((item) => [item.phrase, item.frequency ?? null]),
  };
  return runScenario(
    session,
    {
      label: "content_plan",
      params: settings,
      estimate,
      summary: { seeds, source, depth, phrases: given.length },
      warnings,
    },
    options,
    async () => {
      const questions: Question[] = findQuestions(given);
      let used: ContentPlanSummary["source"] = "input";
      let notes: string[] = [];
      let partial = false;
      let processing = false;
      if (seeds.length > 0) {
        const collected = await collect(
          session,
          { seeds, source, depth, region, serpRegion, questions: true },
          options,
        );
        used = collected.source;
        notes = collected.warnings;
        partial = collected.partial;
        processing = collected.processing;
        const items = collected.phrases.map((item) => ({
          phrase: item.phrase,
          ...(item.frequency === null ? {} : { frequency: item.frequency }),
        }));
        if (collected.source === "serp") {
          for (const item of items) {
            const info = detectQuestion(item.phrase);
            questions.push({ ...item, type: info.type ?? "other", marker: info.marker ?? "" });
          }
        } else {
          questions.push(...findQuestions(items));
        }
      }
      const byPhrase = new Map(questions.map((item) => [item.phrase, item]));
      const clusters = clusterLexical(questions, { mode: "soft" }).slice(0, maxTopics);
      const rows = clusters.map((cluster) => {
        const main = byPhrase.get(cluster.main.phrase);
        const rest = cluster.phrases.slice(1).map((item) => item.phrase);
        return {
          topic: topicTitle(cluster.main.phrase),
          main_query: cluster.main.phrase,
          frequency: cluster.frequency,
          questions: cluster.phrases.length,
          subquestions: rest.slice(0, MAX_SUBQUESTIONS).join("; "),
          type: main?.type ?? "other",
          marker: main?.marker ?? "",
        };
      });
      if (questions.length === 0) {
        notes.push("Вопросов не найдено. No questions found.");
      }
      return {
        table: table(
          [
            str("topic", "Тема статьи"),
            str("main_query", "Главный запрос"),
            num("frequency", "Сумма частот"),
            num("questions", "Вопросов"),
            str("subquestions", "Подвопросы"),
            str("type", "Тип вопроса"),
            str("marker", "Вопросительное слово"),
          ],
          rows,
          { query: seeds.join(", ") },
        ),
        summary: { source: used, questions: questions.length, topics: rows.length },
        warnings: notes,
        partial,
        processing,
      };
    },
  );
}
