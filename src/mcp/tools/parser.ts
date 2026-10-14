import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CompetitionResult, ParserRunResult } from "../../session.js";
import { competitionTable } from "../../tables/lists.js";
import { directBidsTable, frequencyTable, wordstatKeywordsTable } from "../../tables/parser.js";
import type { ResultTable } from "../../tables/types.js";
import type { McpDeps } from "../context.js";
import { runPaid } from "../paid.js";
import { outputSchema } from "../respond.js";
import {
  frequencyTypes,
  handler,
  newTaskParam,
  PAID,
  paidParams,
  phrasesParam,
  wordstatRegion,
} from "./common.js";

const DIRECT = "Depends on Yandex Direct, may take long.";
const DIRECT_RU = "Зависит от Яндекс Директа, может считаться долго.";

function parserOutcome(render: (result: ParserRunResult) => ResultTable) {
  return (result: ParserRunResult) => ({
    table: render(result),
    fromCache: result.parts.every((part) => part.fromCache),
  });
}

export function registerParserTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "mutagen_frequency",
    {
      title: "Wordstat frequency",
      description: `Wordstat frequencies of phrases: base, "phrase", "!exact", [order] and combinations, any region. Cost: 0.02 RUB per phrase per type.\nЧастотность фраз Вордстата: базовая, "фразовая", "!точная", [порядок]; регион. Цена: 0,02 ₽ × фраза × вид.\nNext / Дальше: mutagen_competition.`,
      inputSchema: z.object({
        phrases: phrasesParam,
        types: z
          .array(frequencyTypes)
          .min(1)
          .optional()
          .describe(
            'Default wordstat_n. n base, q "phrase", qs "!exact", no [order], qo "[order]", qso "[!exact order]"',
          ),
        region: wordstatRegion,
        ...newTaskParam,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_frequency", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) =>
          session.frequency(args.phrases, args.types ?? ["wordstat_n"], args.region, options),
        parserOutcome(frequencyTable),
      ),
    ),
  );

  server.registerTool(
    "mutagen_wordstat_keywords",
    {
      title: "Wordstat left column",
      description: `Wordstat left column for a seed, 200 or 2000 phrases. Cost: 0.02 RUB (200), 0.20 RUB (2000).\nЛевая колонка Вордстата по фразе. Цена: 0,02 ₽ (200), 0,20 ₽ (2000).\nNext / Дальше: mutagen_frequency.`,
      inputSchema: z.object({
        phrase: z.string().trim().min(1).describe("Seed phrase"),
        depth: z.literal([200, 2000]).optional().describe("Phrases to collect, default 200"),
        region: wordstatRegion,
        ...newTaskParam,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_wordstat_keywords", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) =>
          session.wordstatKeywords(args.phrase, args.depth ?? 200, args.region, options),
        parserOutcome(wordstatKeywordsTable),
      ),
    ),
  );

  server.registerTool(
    "mutagen_direct_bids",
    {
      title: "Yandex Direct bids",
      description: `Yandex Direct bids and traffic forecast by position for phrases. Cost: 0.02 RUB per phrase. ${DIRECT}\nСтавки и прогноз Яндекс.Директа по фразам. Цена: 0,02 ₽ × фраза. ${DIRECT_RU}`,
      inputSchema: z.object({
        phrases: phrasesParam,
        region: wordstatRegion,
        ...newTaskParam,
        ...paidParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_direct_bids", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) => session.directBids(args.phrases, args.region, options),
        parserOutcome(directBidsTable),
      ),
    ),
  );

  server.registerTool(
    "mutagen_competition",
    {
      title: "Keyword competition",
      description: `Keyword competition score 0–25 with "quoted" frequency, tails, Direct bids and vital site. Cost: 0.30 RUB per phrase; a phrase checked within 7 days is free. ${DIRECT}\nКонкуренция по фразам (0–25), частота "в кавычках", хвосты, ставки. Цена: 0,30 ₽ × фраза; повтор за 7 дней бесплатно. ${DIRECT_RU}`,
      inputSchema: z.object({ phrases: phrasesParam, ...paidParams }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_competition", (args, env) =>
      runPaid(
        env,
        args,
        (session, options) => session.competition(args.phrases, options),
        (result: CompetitionResult) => ({
          table: competitionTable(result),
          fromCache: result.results.every((row) => row.fromCache),
        }),
      ),
    ),
  );
}
