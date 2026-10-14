import { Argument, type Command } from "commander";
import { SERP_REGION_IDS } from "../../core/regions.js";
import {
  REPORT_NAMES,
  REPORT_OBJECTS,
  REPORTS,
  type ReportName,
  type ReportObject,
} from "../../core/reports.js";
import type { SerpReportParams } from "../../core/types.js";
import type { SerpCountResult, SerpReportResult } from "../../session.js";
import { serpReportTable } from "../../tables/lists.js";
import { table } from "../../tables/types.js";
import type { CliContext } from "../context.js";
import { usageError } from "../errors.js";
import { readListFile } from "../input.js";
import { runPaid } from "../paid.js";
import type { Register } from "./shared.js";

export const REPORT_KINDS = ["keyword", "domain", "page", "raw"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const KIND_OBJECTS: Readonly<Record<ReportKind, readonly ReportObject[]>> = {
  keyword: ["keyword", "keywords"],
  domain: ["domain", "domain_with_subdomains"],
  page: ["page"],
  raw: REPORT_OBJECTS,
};

interface ReportOptions {
  region: string;
  input?: string;
  filter?: string;
  sort?: string;
  count?: boolean;
  subdomains?: boolean;
  object?: string;
}

export function reportsFor(kind: ReportKind): ReportName[] {
  const objects = KIND_OBJECTS[kind];
  return REPORT_NAMES.filter((name) =>
    (REPORTS[name].objects as readonly ReportObject[]).some((object) => objects.includes(object)),
  );
}

export function shortName(name: ReportName): string {
  return name.replace(/^report_/, "");
}

export function resolveReport(kind: ReportKind, value: string): ReportName {
  const allowed = reportsFor(kind);
  const name = value.trim().toLowerCase();
  const candidates = [name, `report_${name}`, `report_${kind}_${name}`];
  const found = allowed.find((report) => candidates.includes(report));
  if (!found) {
    const list = allowed.map(shortName).join(", ");
    throw usageError(
      `Неизвестный отчет «${value}» для ${kind}. Доступны: ${list}.`,
      `Unknown ${kind} report "${value}". Available: ${list}.`,
    );
  }
  return found;
}

function parseFilter(value: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw usageError(
      '--filter: нужен JSON-массив условий, например [{"column":"region_wsn","filter_type":">","val":100}].',
      "--filter: expected a JSON array of conditions.",
    );
  }
  return list as Record<string, unknown>[];
}

async function reportObject(
  ctx: CliContext,
  kind: ReportKind,
  report: ReportName,
  target: string | undefined,
  options: ReportOptions,
): Promise<Partial<Record<ReportObject, string | string[]>>> {
  const keywords =
    options.input === undefined ? undefined : await readListFile(ctx.io, options.input);
  if (keywords && target !== undefined) {
    throw usageError(
      "Укажите либо цель аргументом, либо список фраз через -i, но не оба сразу.",
      "Give either a target argument or a phrase list with -i, not both.",
    );
  }
  if (keywords) return { keywords };
  if (target === undefined || target.trim() === "") {
    throw usageError(
      `Укажите цель отчета: ${kind === "keyword" ? "фразу (или -i со списком фраз)" : kind === "page" ? "URL страницы" : "домен или фразу"}.`,
      "Specify the report target.",
    );
  }
  if (kind === "domain") {
    return options.subdomains ? { domain_with_subdomains: target } : { domain: target };
  }
  if (kind === "page") return { page: target };
  if (kind === "keyword") return { keyword: target };
  const objects = REPORTS[report].objects as readonly ReportObject[];
  const object = (options.object ?? objects[0]) as ReportObject;
  if (!REPORT_OBJECTS.includes(object)) {
    throw usageError(
      `--object: допустимо ${REPORT_OBJECTS.join(", ")}.`,
      `--object: use one of ${REPORT_OBJECTS.join(", ")}.`,
    );
  }
  return object === "keywords" ? { keywords: target.split(",") } : { [object]: target };
}

export const registerReport: Register = (program, context) => {
  program
    .command("report")
    .description(
      "Mega-tool report, needs a subscription, 1 request of the daily quota. — Отчет Мега-инструмента по подписке.",
    )
    .addArgument(new Argument("<object>", "keyword | domain | page | raw").choices(REPORT_KINDS))
    .argument("<report>", "report name without report_, e.g. tailings, keywords_organic")
    .argument("[target]", "phrase, domain or page URL / фраза, домен или URL")
    .option("-r, --region <id>", `Mega-tool region: ${SERP_REGION_IDS.join(", ")}`, "yandex_msk")
    .option("-i, --input <file>", "phrase list for keyword_info / variations, up to 1000")
    .option("--filter <json>", "filter conditions, JSON array / фильтр, JSON-массив")
    .option("--sort <column>", 'sort, e.g. "region_wsn desc" / сортировка')
    .option("--count", "only the number of rows / только число строк")
    .option("--subdomains", "domain with subdomains / домен с поддоменами")
    .option("--object <name>", "raw: report object field / поле объекта для raw")
    .action(
      async (
        kind: ReportKind,
        name: string,
        target: string | undefined,
        options: ReportOptions,
        cmd: Command,
      ) => {
        const ctx = context(cmd);
        const report = resolveReport(kind, name);
        const objects = await reportObject(ctx, kind, report, target, options);
        const params = {
          report,
          region: options.region,
          ...objects,
          ...(options.filter === undefined ? {} : { filter: parseFilter(options.filter) }),
          ...(options.sort === undefined ? {} : { sort: options.sort }),
          ...(ctx.opts.limit === undefined ? {} : { limit: ctx.opts.limit }),
        } as unknown as SerpReportParams;
        const query = Object.values(objects)
          .map((value) => (Array.isArray(value) ? value.join(", ") : String(value)))
          .join(", ");
        if (options.count) {
          await runPaid(
            ctx,
            `report ${shortName(report)} --count`,
            (session, call) => session.serpReportCount(params, call),
            (result: SerpCountResult) => ({
              table: table(
                [{ key: "count", title: "Строк в отчете", type: "number" }],
                [{ count: result.count }],
                { query, region: options.region },
              ),
              fromCache: result.fromCache,
              lines: [`${shortName(report)}: ${result.count} строк / rows.`],
            }),
          );
          return;
        }
        await runPaid(
          ctx,
          `report ${shortName(report)}`,
          (session, call) => session.serpReport(params, call),
          (result: SerpReportResult) => ({
            table: serpReportTable(report, result.rows, { query, region: options.region }),
            fromCache: result.fromCache,
          }),
        );
      },
    );
};
