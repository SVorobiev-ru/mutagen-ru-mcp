import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ClusterSummary } from "../../scenarios/cluster.js";
import { cluster, clusterIsLocal } from "../../scenarios/cluster.js";
import type { ScenarioDone } from "../../scenarios/common.js";
import {
  type BuildCoreSummary,
  buildCore,
  type ExpandCoreSummary,
  expandCore,
} from "../../scenarios/core.js";
import { type ContentGapSummary, contentGap } from "../../scenarios/gap.js";
import { type MinusWordsSummary, minusWords, minusWordsIsLocal } from "../../scenarios/minus.js";
import { type ContentPlanSummary, contentPlan, contentPlanIsLocal } from "../../scenarios/plan.js";
import { type TitleH1Summary, titleH1, titleH1IsLocal } from "../../scenarios/title.js";
import { MINUS_CATEGORIES, type MinusCategory } from "../../text/minus.js";
import type { McpDeps } from "../context.js";
import { runPaid } from "../paid.js";
import type { Outcome } from "../respond.js";
import { outputSchema } from "../respond.js";
import {
  frequencyTypes,
  handler,
  PAID,
  paidParams,
  phraseInputs,
  phraseItemsParam,
} from "./common.js";

const BUDGET = "Cost: by estimate, ≤ budget_rub.";
const BUDGET_RU = "Цена: по смете, не больше budget_rub.";

const seeds = z.array(z.string()).min(1).max(20);
const budget = z.number().positive();
const source = z.enum(["wordstat", "serp", "auto"]).optional();
const depth = z.literal([200, 2000]).optional();
const region = z.string().optional();
const serpRegion = z.string().optional();
const count = z.number().int().min(0).max(50_000).optional();
const minusCategory = z.enum(Object.keys(MINUS_CATEGORIES) as [MinusCategory, ...MinusCategory[]]);

function partialLine(processing: boolean): string {
  return processing
    ? "Частичный результат: Мутаген еще считает. Повторите тот же вызов позже — повтор бесплатный / Partial result: still processing, repeat the same call later for free."
    : "Частичный результат: смета или бюджет исчерпаны / Partial result: the approved estimate ran out.";
}

function scenarioOutcome<S>(result: ScenarioDone<S>, lines: string[] = []): Outcome {
  return {
    table: result.table,
    summary: result.summary as Record<string, unknown>,
    ...(result.partial ? { partial: true } : {}),
    ...(result.processing ? { status: "processing" as const } : {}),
    lines: [
      ...lines,
      ...(result.partial ? [partialLine(result.processing)] : []),
      `Итоги / Summary: ${JSON.stringify(result.summary)}`,
    ],
  };
}

export function registerScenarioTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "mutagen_build_core",
    {
      title: "Build core",
      description: `Semantic core: seed tails → cleanup → exact frequencies → competition of top N → clusters. ${BUDGET}\nСемантическое ядро; убирает явный мусор для SEO: скачать, учёба, вакансии, б/у, развлечения. ${BUDGET_RU}`,
      inputSchema: z.object({
        seeds,
        budget_rub: budget,
        source,
        depth,
        region,
        serp_region: serpRegion,
        min_frequency: count,
        exact_types: z.array(frequencyTypes).optional().describe("Default wordstat_qs"),
        min_exact: count,
        stop_words: z.array(z.string()).optional(),
        exclude_minus: z.boolean().optional().describe("Default true"),
        exclude_categories: z.array(minusCategory).optional(),
        max_phrases: count.describe("Default 500"),
        competition_top: count,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_build_core", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) =>
          buildCore(
            session,
            {
              seeds: args.seeds,
              budgetRub: args.budget_rub,
              source: args.source,
              depth: args.depth,
              region: args.region,
              serpRegion: args.serp_region,
              minFrequency: args.min_frequency,
              exactTypes: args.exact_types,
              minExact: args.min_exact,
              stopWords: args.stop_words,
              excludeMinus: args.exclude_minus,
              excludeCategories: args.exclude_categories,
              maxPhrases: args.max_phrases,
              competitionTop: args.competition_top,
            },
            options,
          ),
        (result: ScenarioDone<BuildCoreSummary>) => scenarioOutcome(result),
      ),
    ),
  );

  server.registerTool(
    "mutagen_expand_core",
    {
      title: "Expand core",
      description: `New phrases for a core: tails of seeds or cluster heads. ${BUDGET}\nРасширение ядра. ${BUDGET_RU}`,
      inputSchema: z.object({
        phrases: phraseItemsParam,
        budget_rub: budget,
        seeds: seeds.optional(),
        source,
        depth,
        region,
        serp_region: serpRegion,
        max_new: count,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_expand_core", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) =>
          expandCore(
            session,
            {
              phrases: phraseInputs(args.phrases),
              budgetRub: args.budget_rub,
              seeds: args.seeds,
              source: args.source,
              depth: args.depth,
              region: args.region,
              serpRegion: args.serp_region,
              maxNew: args.max_new,
            },
            options,
          ),
        (result: ScenarioDone<ExpandCoreSummary>) => scenarioOutcome(result),
      ),
    ),
  );

  server.registerTool(
    "mutagen_cluster",
    {
      title: "Cluster keywords",
      description:
        "Clusters: lexical (Free), by SERP (subscription, 1 quota request per phrase, ≤300) or a Favorites project (Free).\nКластеры: лексически, по выдаче (подписка) или из «Избранного». Бесплатно.",
      inputSchema: z.object({
        phrases: phraseItemsParam.optional(),
        mode: z.enum(["lexical", "serp", "project"]).optional(),
        strictness: z
          .enum(["strict", "soft", "hard"])
          .optional()
          .describe("lexical strict|soft, serp soft|hard"),
        threshold: z.number().max(1).optional(),
        min_common: z.number().int().min(1).max(50).optional(),
        serp_region: serpRegion,
        project_id: z.number().int().min(1).max(1e9).optional(),
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_cluster", (args, env) => {
      const params = {
        phrases: phraseInputs(args.phrases),
        mode: args.mode,
        strictness: args.strictness,
        threshold: args.threshold,
        minCommon: args.min_common,
        serpRegion: args.serp_region,
        projectId: args.project_id,
      };
      return runPaid(
        env,
        args,
        (session, options) => cluster(session, params, options),
        (result: ScenarioDone<ClusterSummary>) => scenarioOutcome(result),
        clusterIsLocal(params),
      );
    }),
  );

  server.registerTool(
    "mutagen_title_h1",
    {
      title: "Title and H1",
      description:
        'Title, H1, Description for a cluster by frequent forms. Free with frequencies, else Cost: 0.02 RUB per phrase ("!exact").\nTitle, H1, Description кластера. Бесплатно с частотами, иначе цена 0,02 ₽ × фраза.',
      inputSchema: z.object({
        phrases: phraseItemsParam,
        brand: z.string().optional(),
        city: z.string().optional(),
        region,
        budget_rub: budget.optional(),
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_title_h1", (args, env) => {
      const params = {
        phrases: phraseInputs(args.phrases),
        brand: args.brand,
        city: args.city,
        region: args.region,
        budgetRub: args.budget_rub,
      };
      return runPaid(
        env,
        args,
        (session, options) => titleH1(session, params, options),
        (result: ScenarioDone<TitleH1Summary>) =>
          scenarioOutcome(result, [
            `Title: ${result.summary.title}`,
            `H1: ${result.summary.h1}`,
            `Description: ${result.summary.description}`,
          ]),
        titleH1IsLocal(params),
      );
    }),
  );

  server.registerTool(
    "mutagen_content_gap",
    {
      title: "Content gap",
      description:
        "Competitor keywords the domain lacks. Needs a Mega-tool subscription, 1 quota request per domain.\nФразы конкурентов, которых нет у сайта. Нужна подписка.",
      inputSchema: z.object({
        domain: z.string(),
        competitors: z.array(z.string()).min(1).max(10).optional().describe("Default auto"),
        competitors_top: z.number().int().min(1).max(10).optional(),
        serp_region: serpRegion,
        min_frequency: count,
        limit_per_domain: count,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_content_gap", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) =>
          contentGap(
            session,
            {
              domain: args.domain,
              competitors: args.competitors ?? "auto",
              competitorsTop: args.competitors_top,
              serpRegion: args.serp_region,
              minFrequency: args.min_frequency,
              limitPerDomain: args.limit_per_domain,
            },
            options,
          ),
        (result: ScenarioDone<ContentGapSummary>) => scenarioOutcome(result),
      ),
    ),
  );

  server.registerTool(
    "mutagen_minus_words",
    {
      title: "Negative keywords",
      description: `Negative keywords and a "-word" line for Yandex Direct. Free for phrases; for seeds ${BUDGET}\nМинус-слова для Директа. ${BUDGET_RU} По фразам бесплатно.`,
      inputSchema: z.object({
        seeds: seeds.optional(),
        phrases: phraseItemsParam.optional(),
        budget_rub: budget.optional(),
        depth,
        region,
        target_words: z.array(z.string()).optional(),
        include_disputed: z.boolean().optional(),
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_minus_words", (args, env) => {
      const params = {
        seeds: args.seeds,
        phrases: phraseInputs(args.phrases),
        budgetRub: args.budget_rub,
        depth: args.depth,
        region: args.region,
        targetWords: args.target_words,
        includeDisputed: args.include_disputed,
      };
      return runPaid(
        env,
        args,
        (session, options) => minusWords(session, params, options),
        (result: ScenarioDone<MinusWordsSummary>) =>
          scenarioOutcome(result, [`Минус-слова / Direct: ${result.summary.direct}`]),
        minusWordsIsLocal(params),
      );
    }),
  );

  server.registerTool(
    "mutagen_content_plan",
    {
      title: "Content plan",
      description: `Article topics from clustered questions. Free for phrases; for seeds ${BUDGET}\nКонтент-план из вопросов. ${BUDGET_RU} По фразам бесплатно.`,
      inputSchema: z.object({
        seeds: seeds.optional(),
        phrases: phraseItemsParam.optional(),
        budget_rub: budget.optional(),
        source,
        depth,
        region,
        serp_region: serpRegion,
        max_topics: count,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_content_plan", (args, env) => {
      const params = {
        seeds: args.seeds,
        phrases: phraseInputs(args.phrases),
        budgetRub: args.budget_rub,
        source: args.source,
        depth: args.depth,
        region: args.region,
        serpRegion: args.serp_region,
        maxTopics: args.max_topics,
      };
      return runPaid(
        env,
        args,
        (session, options) => contentPlan(session, params, options),
        (result: ScenarioDone<ContentPlanSummary>) => scenarioOutcome(result),
        contentPlanIsLocal(params),
      );
    }),
  );
}
