import { type Command, Option } from "commander";
import { SERP_REGION_IDS } from "../../core/regions.js";
import type { FrequencyParser } from "../../core/types.js";
import {
  type ClusterMode,
  type ClusterStrictness,
  cluster,
  clusterIsLocal,
} from "../../scenarios/cluster.js";
import { COLLECT_SOURCES, type CollectSource } from "../../scenarios/collect.js";
import type { ScenarioDone } from "../../scenarios/common.js";
import { buildCore, expandCore, SEO_JUNK_CATEGORIES } from "../../scenarios/core.js";
import { contentGap } from "../../scenarios/gap.js";
import { type MinusWordsSummary, minusWords, minusWordsIsLocal } from "../../scenarios/minus.js";
import { contentPlan, contentPlanIsLocal } from "../../scenarios/plan.js";
import { type TitleH1Summary, titleH1, titleH1IsLocal } from "../../scenarios/title.js";
import { MINUS_CATEGORIES, type MinusCategory } from "../../text/minus.js";
import type { CliContext } from "../context.js";
import { usageError } from "../errors.js";
import {
  collectOption,
  depth,
  listOption,
  nonNegativeInt,
  parseTypes,
  positiveInt,
  readPhraseItems,
} from "../input.js";
import type { CliOutcome } from "../output.js";
import { runPaid } from "../paid.js";
import type { Register } from "./shared.js";

const REGION = "Wordstat region ids, default 225 / регион Вордстата";
const SERP_REGION = `Mega-tool region: ${SERP_REGION_IDS.join(", ")}; default yandex_msk`;
const INPUT =
  "txt (one phrase per line) or csv with phrase/фраза and frequency/частота, - for stdin";

function budgetOf(ctx: CliContext, required = true): number | undefined {
  if (ctx.opts.budget === undefined && required) {
    throw usageError(
      "Укажите бюджет сценария: --budget N (рубли). Смету без трат покажет --dry-run.",
      "Set the scenario budget with --budget N (RUB); --dry-run shows the estimate.",
    );
  }
  return ctx.opts.budget;
}

function sourceOption() {
  return new Option("--source <source>", "wordstat | serp | auto (default)").choices(
    COLLECT_SOURCES,
  );
}

function depthOption() {
  return new Option("--depth <n>", "200 or 2000 phrases per seed").argParser(depth);
}

function outcome<S>(result: ScenarioDone<S>, lines: string[] = []): CliOutcome {
  return {
    table: result.table,
    lines: [
      ...lines,
      ...(result.partial
        ? [
            result.processing
              ? "Частичный результат: Мутаген еще считает, повтор команды бесплатный / Partial result: still processing, repeat for free."
              : "Частичный результат: смета исчерпана / Partial result: the estimate ran out.",
          ]
        : []),
      `Итоги / Summary: ${JSON.stringify(result.summary)}`,
    ],
  };
}

interface CoreOptions {
  depth?: 200 | 2000;
  max?: number;
  competition?: number;
  source?: CollectSource;
  region?: string;
  serpRegion?: string;
  types?: FrequencyParser[];
  minFrequency?: number;
  minExact?: number;
  stopWords?: string[];
  exclude?: MinusCategory[];
  keepMinus?: boolean;
}

export const registerScenarios: Register = (program, context) => {
  program
    .command("core")
    .description(
      "Semantic core from seeds within --budget: tails → cleanup → exact frequencies → clusters. — Семантическое ядро в пределах бюджета; убирает явный мусор для SEO: скачать, учёба, вакансии, б/у, развлечения.",
    )
    .argument("<seeds...>", "seed phrases, 1–20 / маркеры")
    .addOption(depthOption())
    .option("--max <n>", "max phrases with exact frequencies, default 500", positiveInt)
    .option("--competition <n>", "check competition for the top N phrases", nonNegativeInt)
    .addOption(sourceOption())
    .option("-r, --region <ids>", REGION)
    .option("--serp-region <id>", SERP_REGION)
    .option("-t, --types <list>", "exact frequency types, default qs", parseTypes)
    .option("--min-frequency <n>", "min base frequency", nonNegativeInt)
    .option("--min-exact <n>", "min exact frequency", nonNegativeInt)
    .option("--stop-words <list>", "drop phrases with these words, comma-separated", listOption)
    .option(
      "--exclude <list>",
      `junk categories to drop: ${Object.keys(MINUS_CATEGORIES).join(", ")}; default ${SEO_JUNK_CATEGORIES.join(",")}`,
      listOption,
    )
    .option("--keep-minus", "keep phrases with off-target words / не убирать минус-слова")
    .action(async (seeds: string[], options: CoreOptions, cmd: Command) => {
      const ctx = context(cmd);
      const budgetRub = budgetOf(ctx) as number;
      await runPaid(
        ctx,
        "core",
        (session, call) =>
          buildCore(
            session,
            {
              seeds,
              budgetRub,
              depth: options.depth,
              maxPhrases: options.max,
              competitionTop: options.competition,
              source: options.source,
              region: options.region,
              serpRegion: options.serpRegion,
              exactTypes: options.types,
              minFrequency: options.minFrequency,
              minExact: options.minExact,
              stopWords: options.stopWords,
              excludeMinus: !options.keepMinus,
              excludeCategories: options.exclude,
            },
            call,
          ),
        (result: ScenarioDone<unknown>) => outcome(result),
      );
    });

  program
    .command("expand")
    .description(
      "New phrases for an existing core within --budget. — Расширение ядра новыми фразами.",
    )
    .argument("[phrases...]", "core phrases / фразы ядра")
    .option("-i, --input <file>", INPUT, collectOption)
    .option("--seeds <list>", "seed phrases, default: heads of the core clusters", listOption)
    .option("--max-new <n>", "max new phrases, default 500", positiveInt)
    .addOption(sourceOption())
    .addOption(depthOption())
    .option("-r, --region <ids>", REGION)
    .option("--serp-region <id>", SERP_REGION)
    .action(
      async (
        args: string[],
        options: {
          input?: string[];
          seeds?: string[];
          maxNew?: number;
          source?: CollectSource;
          depth?: 200 | 2000;
          region?: string;
          serpRegion?: string;
        },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const budgetRub = budgetOf(ctx) as number;
        const phrases = await readPhraseItems(ctx.io, args, options.input);
        await runPaid(
          ctx,
          "expand",
          (session, call) =>
            expandCore(
              session,
              {
                phrases,
                budgetRub,
                seeds: options.seeds,
                maxNew: options.maxNew,
                source: options.source,
                depth: options.depth,
                region: options.region,
                serpRegion: options.serpRegion,
              },
              call,
            ),
          (result: ScenarioDone<unknown>) => outcome(result),
        );
      },
    );

  program
    .command("cluster")
    .description(
      "Clusters: lexical (free), by SERP (subscription) or from a Favorites project. — Кластеризация фраз.",
    )
    .argument("[phrases...]", "phrases / фразы")
    .option("-i, --input <file>", INPUT, collectOption)
    .addOption(
      new Option("--mode <mode>", "lexical (default) | serp | project").choices([
        "lexical",
        "serp",
        "project",
      ]),
    )
    .addOption(
      new Option("--strictness <s>", "lexical: strict | soft; serp: soft | hard").choices([
        "strict",
        "soft",
        "hard",
      ]),
    )
    .option("--threshold <x>", "lexical soft similarity, default 0.5", Number)
    .option("--min-common <n>", "serp: shared URLs, default 3", positiveInt)
    .option(
      "--project <id>",
      "mode project: Favorites project id from the project page URL",
      positiveInt,
    )
    .option("--serp-region <id>", SERP_REGION)
    .action(
      async (
        args: string[],
        options: {
          input?: string[];
          mode?: ClusterMode;
          strictness?: ClusterStrictness;
          threshold?: number;
          minCommon?: number;
          project?: number;
          serpRegion?: string;
        },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const phrases = await readPhraseItems(
          ctx.io,
          args,
          options.input,
          options.mode !== "project",
        );
        const params = {
          phrases,
          mode: options.mode,
          strictness: options.strictness,
          threshold: options.threshold,
          minCommon: options.minCommon,
          projectId: options.project,
          serpRegion: options.serpRegion,
        };
        await runPaid(
          ctx,
          "cluster",
          (session, call) => cluster(session, params, call),
          (result: ScenarioDone<unknown>) => outcome(result),
          clusterIsLocal(params),
        );
      },
    );

  program
    .command("title")
    .description(
      "Title, H1 and Description for a cluster by frequent forms. — Title, H1 и Description кластера.",
    )
    .argument("[phrases...]", "cluster phrases / фразы кластера")
    .option("-i, --input <file>", INPUT, collectOption)
    .option("--brand <name>", "brand for Title and Description")
    .option("--city <name>", "city")
    .option("-r, --region <ids>", REGION)
    .action(
      async (
        args: string[],
        options: { input?: string[]; brand?: string; city?: string; region?: string },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const phrases = await readPhraseItems(ctx.io, args, options.input);
        const params = {
          phrases,
          brand: options.brand,
          city: options.city,
          region: options.region,
          budgetRub: budgetOf(ctx, false),
        };
        await runPaid(
          ctx,
          "title",
          (session, call) => titleH1(session, params, call),
          (result: ScenarioDone<TitleH1Summary>) => outcome(result),
          titleH1IsLocal(params),
        );
      },
    );

  program
    .command("gap")
    .description(
      "Competitor keywords the domain lacks; needs a Mega-tool subscription. — Фразы конкурентов, которых нет у сайта.",
    )
    .argument("<domain>", "your domain / ваш домен")
    .option("--competitors <list>", "competitor domains, default: auto from Mutagen", listOption)
    .option("--top <n>", "auto competitors, default 5", positiveInt)
    .option("-r, --region <id>", SERP_REGION)
    .option("--min-frequency <n>", "min frequency", nonNegativeInt)
    .option("--per-domain <n>", "keywords per domain, default 1000", positiveInt)
    .action(
      async (
        domain: string,
        options: {
          competitors?: string[];
          top?: number;
          region?: string;
          minFrequency?: number;
          perDomain?: number;
        },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        await runPaid(
          ctx,
          "gap",
          (session, call) =>
            contentGap(
              session,
              {
                domain,
                competitors: options.competitors ?? "auto",
                competitorsTop: options.top,
                serpRegion: options.region,
                minFrequency: options.minFrequency,
                limitPerDomain: options.perDomain,
              },
              call,
            ),
          (result: ScenarioDone<unknown>) => outcome(result),
        );
      },
    );

  program
    .command("minus")
    .description(
      "Negative keywords for Yandex Direct from seeds (Wordstat, by estimate) or phrases (-i, free). — Минус-слова для Директа.",
    )
    .argument("[seeds...]", "seed phrases / маркеры")
    .option("-i, --input <file>", INPUT, collectOption)
    .addOption(depthOption())
    .option("-r, --region <ids>", REGION)
    .option("--target <list>", "words never suggested, default: seed words", listOption)
    .option("--disputed", "add disputed words to the Direct line / добавить спорные")
    .action(
      async (
        seeds: string[],
        options: {
          input?: string[];
          depth?: 200 | 2000;
          region?: string;
          target?: string[];
          disputed?: boolean;
        },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const phrases = await readPhraseItems(ctx.io, [], options.input, false);
        const params = {
          seeds,
          phrases,
          depth: options.depth,
          region: options.region,
          targetWords: options.target,
          includeDisputed: options.disputed,
          budgetRub: budgetOf(ctx, false),
        };
        await runPaid(
          ctx,
          "minus",
          (session, call) => minusWords(session, params, call),
          (result: ScenarioDone<MinusWordsSummary>) =>
            outcome(result, [`Минус-слова для Директа / Direct: ${result.summary.direct}`]),
          minusWordsIsLocal(params),
        );
      },
    );

  program
    .command("plan")
    .description(
      "Content plan from question phrases and clusters within --budget. — Контент-план из вопросов.",
    )
    .argument("[seeds...]", "seed phrases / маркеры")
    .option("-i, --input <file>", INPUT, collectOption)
    .addOption(sourceOption())
    .addOption(depthOption())
    .option("-r, --region <ids>", REGION)
    .option("--serp-region <id>", SERP_REGION)
    .option("--topics <n>", "max topics", positiveInt)
    .action(
      async (
        seeds: string[],
        options: {
          input?: string[];
          source?: CollectSource;
          depth?: 200 | 2000;
          region?: string;
          serpRegion?: string;
          topics?: number;
        },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const phrases = await readPhraseItems(ctx.io, [], options.input, false);
        const params = {
          seeds,
          phrases,
          source: options.source,
          depth: options.depth,
          region: options.region,
          serpRegion: options.serpRegion,
          maxTopics: options.topics,
          budgetRub: budgetOf(ctx, seeds.length > 0),
        };
        await runPaid(
          ctx,
          "plan",
          (session, call) => contentPlan(session, params, call),
          (result: ScenarioDone<unknown>) => outcome(result),
          contentPlanIsLocal(params),
        );
      },
    );
};
