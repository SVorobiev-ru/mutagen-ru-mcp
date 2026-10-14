import { Command, Option } from "commander";
import { VERSION } from "../mcp/context.js";
import { registerFree } from "./commands/free.js";
import { registerParser } from "./commands/parser.js";
import { registerReport } from "./commands/report.js";
import { registerScenarios } from "./commands/scenarios.js";
import { registerText } from "./commands/text.js";
import { CliContext, type GlobalOptions } from "./context.js";
import { debugEnabled, describeError, EXIT } from "./errors.js";
import { positiveInt, rubles } from "./input.js";
import { type CliIo, redacting } from "./io.js";

export function buildProgram(io: CliIo): Command {
  const program = new Command("mutagen-ru")
    .description(
      "Unofficial CLI for the Mutagen (mutagen.ru) SEO API. — Неофициальный CLI для API Мутагена.",
    )
    .version(VERSION, "-V, --version")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    })
    .configureHelp({ showGlobalOptions: true })
    .option("-o, --output <file>", "save all rows to .csv/.json/.ndjson/.xlsx / сохранить в файл")
    .addOption(
      new Option(
        "--format <format>",
        "stdout format; default table in a terminal, else csv",
      ).choices(["table", "csv", "json"]),
    )
    .option("--json", "machine-readable result: rows, total, estimate, spending / JSON результата")
    .option("--dry-run", "estimate only, no API calls / только смета")
    .option("-y, --yes", "approve the estimate without asking, for CI / подтвердить смету")
    .option("--no-cache", "do not read or write the cache / без кэша")
    .option("--refresh", "ignore cached results / не брать из кэша")
    .option("--new-task", "pay for a new mass task instead of a stuck one / новое задание")
    .option(
      "--budget <rub>",
      "budget for this run and its scenario, RUB (min with MUTAGEN_BUDGET_RUB)",
      rubles,
    )
    .option("--free-only", "refuse any paid call / только бесплатное")
    .option("--limit <n>", "rows to print (table default 20) / строк в выводе", positiveInt)
    .option("-q, --quiet", "no info lines on stderr / без пояснений");

  const context = (cmd: Command) => new CliContext(io, cmd.optsWithGlobals<GlobalOptions>());
  registerFree(program, context);
  registerParser(program, context);
  registerReport(program, context);
  registerScenarios(program, context);
  registerText(program, context);
  return program;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const secret = io.env.MUTAGEN_API_KEY?.trim();
  const safe: CliIo = {
    ...io,
    stdout: redacting(io.stdout, secret),
    stderr: redacting(io.stderr, secret),
  };
  try {
    await buildProgram(safe).parseAsync([...argv], { from: "user" });
    return EXIT.ok;
  } catch (error) {
    const { exitCode, text } = describeError(error, io.signal);
    if (text) safe.stderr.write(`${text}\n`);
    if (debugEnabled(io.env.DEBUG) && error instanceof Error && error.stack) {
      safe.stderr.write(`${error.stack}\n`);
    }
    return exitCode;
  }
}
