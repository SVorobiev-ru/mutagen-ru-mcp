import { Argument, type Command, Option } from "commander";
import { TEXT_OPERATIONS, type TextOperation, textOperation } from "../../scenarios/text.js";
import type { PhraseItem } from "../../text/phrases.js";
import { usageError } from "../errors.js";
import {
  collectOption,
  listOption,
  nonNegativeInt,
  readListFile,
  readPhraseFile,
  readPhraseItems,
} from "../input.js";
import { emit } from "../output.js";
import type { Register } from "./shared.js";

interface TextOptions {
  input?: string[];
  mode?: "explicit" | "implicit";
  implicit?: boolean;
  include?: string[];
  exclude?: string[];
  regex?: string;
  minWords?: number;
  maxWords?: number;
}

export const registerText: Register = (program, context) => {
  program
    .command("text")
    .description(
      "Local phrase processing, free and offline. — Локальная обработка фраз, бесплатно, без API.",
    )
    .addArgument(new Argument("<operation>", TEXT_OPERATIONS.join(" | ")).choices(TEXT_OPERATIONS))
    .argument("[phrases...]", "phrases / фразы")
    .option(
      "-i, --input <file>",
      "txt or csv; compare: two files, combinator: one file per word list; - for stdin",
      collectOption,
    )
    .addOption(
      new Option("--mode <mode>", "dedupe: explicit (default) | implicit").choices([
        "explicit",
        "implicit",
      ]),
    )
    .option("--implicit", "compare by implicit duplicates / сравнение по неявным дублям")
    .option("--include <list>", "filter: keep phrases with these words", listOption)
    .option("--exclude <list>", "filter: drop phrases with these words", listOption)
    .option("--regex <re>", "filter: regular expression")
    .option("--min-words <n>", "filter: min words", nonNegativeInt)
    .option("--max-words <n>", "filter: max words", nonNegativeInt)
    .action(
      async (operation: TextOperation, args: string[], options: TextOptions, cmd: Command) => {
        const ctx = context(cmd);
        const files = options.input ?? [];
        let phrases: PhraseItem[] | undefined;
        let phrasesB: string[] | undefined;
        let lists: string[][] | undefined;
        if (operation === "combinator") {
          if (files.length < 2) {
            throw usageError(
              "combinator: передайте списки слов файлами, по одному -i на список.",
              "combinator: pass word lists as files, one -i per list.",
            );
          }
          lists = await Promise.all(files.map((file) => readListFile(ctx.io, file)));
        } else if (operation === "compare") {
          if (files.length !== 2) {
            throw usageError(
              "compare: передайте два файла: -i a.txt -i b.txt.",
              "compare: pass two files: -i a.txt -i b.txt.",
            );
          }
          const [a, b] = await Promise.all(files.map((file) => readPhraseFile(ctx.io, file)));
          phrases = a;
          phrasesB = (b ?? []).map((item) => item.phrase);
        } else {
          phrases = await readPhraseItems(ctx.io, args, files);
        }
        const { table, summary } = textOperation({
          operation,
          phrases,
          phrasesB,
          lists,
          mode: options.mode,
          implicit: options.implicit,
          include: options.include,
          exclude: options.exclude,
          regex: options.regex,
          minWords: options.minWords,
          maxWords: options.maxWords,
        });
        await emit(ctx, { table, lines: [`${operation}: ${JSON.stringify(summary)}`] });
      },
    );
};
