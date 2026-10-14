import { type Command, Option } from "commander";
import type { FrequencyParser } from "../../core/types.js";
import type { CompetitionResult, ParserRunResult } from "../../session.js";
import { competitionTable } from "../../tables/lists.js";
import { directBidsTable, frequencyTable, wordstatKeywordsTable } from "../../tables/parser.js";
import type { ResultTable } from "../../tables/types.js";
import { depth, parseTypes, readPhrases } from "../input.js";
import { runPaid } from "../paid.js";
import type { Register } from "./shared.js";

const REGION =
  "Yandex region ids, comma-separated, minus excludes, e.g. 225 or 213,-1 / регионы Яндекса";
const INPUT = "file with phrases, one per line, # comments; - for stdin / файл с фразами";

interface PhraseOptions {
  input?: string;
  region?: string;
}

function parserOutcome(render: (result: ParserRunResult) => ResultTable) {
  return (result: ParserRunResult) => ({
    table: render(result),
    fromCache: result.parts.every((part) => part.fromCache),
  });
}

export const registerParser: Register = (program, context) => {
  program
    .command("freq")
    .description(
      "Wordstat frequencies, 0.02 RUB per phrase per type. — Частотность Вордстата, 0,02 ₽ × фраза × вид.",
    )
    .argument("[phrases...]", "phrases / фразы")
    .option("-i, --input <file>", INPUT)
    .option(
      "-t, --types <list>",
      'n base, q "phrase", qs "!exact", no [order], qo, qso; default n',
      parseTypes,
    )
    .option("-r, --region <ids>", REGION)
    .action(
      async (
        args: string[],
        options: PhraseOptions & { types?: FrequencyParser[] },
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const phrases = await readPhrases(ctx.io, args, options.input);
        await runPaid(
          ctx,
          "freq",
          (session, call) =>
            session.frequency(phrases, options.types ?? ["wordstat_n"], options.region, call),
          parserOutcome(frequencyTable),
        );
      },
    );

  program
    .command("keywords")
    .description(
      "Wordstat left column for a seed, 0.02 RUB (200) or 0.20 RUB (2000). — Левая колонка Вордстата.",
    )
    .argument("<phrase>", "seed phrase / фраза-маркер")
    .addOption(
      new Option("--depth <n>", "200 or 2000 phrases / фраз").argParser(depth).default(200),
    )
    .option("-r, --region <ids>", REGION)
    .action(
      async (phrase: string, options: { depth: 200 | 2000; region?: string }, cmd: Command) => {
        const ctx = context(cmd);
        await runPaid(
          ctx,
          "keywords",
          (session, call) => session.wordstatKeywords(phrase, options.depth, options.region, call),
          parserOutcome(wordstatKeywordsTable),
        );
      },
    );

  program
    .command("bids")
    .description(
      "Yandex Direct bids and forecast, 0.02 RUB per phrase; may take 30+ min. — Ставки и прогноз Директа.",
    )
    .argument("[phrases...]", "phrases / фразы")
    .option("-i, --input <file>", INPUT)
    .option("-r, --region <ids>", REGION)
    .action(async (args: string[], options: PhraseOptions, cmd: Command) => {
      const ctx = context(cmd);
      const phrases = await readPhrases(ctx.io, args, options.input);
      await runPaid(
        ctx,
        "bids",
        (session, call) => session.directBids(phrases, options.region, call),
        parserOutcome(directBidsTable),
      );
    });

  program
    .command("competition")
    .description(
      "Keyword competition 0–25, 0.30 RUB per phrase, repeat within 7 days free. — Конкуренция по фразам.",
    )
    .argument("[phrases...]", "phrases / фразы")
    .option("-i, --input <file>", INPUT)
    .action(async (args: string[], options: PhraseOptions, cmd: Command) => {
      const ctx = context(cmd);
      const phrases = await readPhrases(ctx.io, args, options.input);
      await runPaid(
        ctx,
        "competition",
        (session, call) => session.competition(phrases, call),
        (result: CompetitionResult) => ({
          table: competitionTable(result),
          fromCache: result.results.every((row) => row.fromCache),
        }),
      );
    });
};
