import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { REPORT_NAMES, REPORTS, type ReportName, type ReportObject } from "../../core/reports.js";
import type { SerpReportParams } from "../../core/types.js";
import { MAX_SERP_KEYWORDS } from "../../core/validate.js";
import type { SerpReportResult } from "../../session.js";
import { serpReportTable } from "../../tables/lists.js";
import type { McpDeps } from "../context.js";
import { type PaidArgs, runPaid, type ToolEnv } from "../paid.js";
import { outputSchema } from "../respond.js";
import { handler, PAID, paidParams, serpRegion } from "./common.js";

const COST =
  "Needs a Mega-tool subscription: 1 quota request, 0 RUB.\nНужна подписка, 1 запрос квоты.";

function reportsFor(...objects: ReportObject[]) {
  return REPORT_NAMES.filter((name) =>
    (REPORTS[name].objects as readonly ReportObject[]).some((object) => objects.includes(object)),
  ) as [ReportName, ...ReportName[]];
}

const reportParams = {
  region: serpRegion,
  sort: z.string().optional().describe('e.g. "region_wsn desc"'),
  max_rows: z.number().min(1).optional().describe("Rows to request"),
  ...paidParams,
};

interface ReportArgs extends PaidArgs {
  report: ReportName;
  region: string;
  sort?: string | undefined;
  max_rows?: number | undefined;
  filter?: Record<string, unknown>[] | undefined;
}

function runReport(env: ToolEnv, args: ReportArgs, objects: Record<string, unknown>) {
  const params = {
    report: args.report,
    region: args.region,
    ...Object.fromEntries(Object.entries(objects).filter(([, value]) => value !== undefined)),
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    ...(args.max_rows ? { limit: args.max_rows } : {}),
  } as unknown as SerpReportParams;
  const query = Object.values(objects)
    .filter((value) => value !== undefined)
    .map((value) => (Array.isArray(value) ? value.join(", ") : String(value)))
    .join(", ");
  return runPaid(
    env,
    args,
    (session, options) => session.serpReport(params, options),
    (result: SerpReportResult) => ({
      table: serpReportTable(args.report, result.rows, { query, region: args.region }),
      fromCache: result.fromCache,
    }),
  );
}

export function registerSerpTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "mutagen_keyword_report",
    {
      title: "Mega-tool keyword report",
      description: `Mega-tool reports for a keyword or a list: statistics, tails, questions, variations, LSI, top-50, ads. ${COST}\nОтчеты Мега-инструмента по фразе или списку. Без подписки: mutagen_wordstat_keywords.`,
      inputSchema: z.object({
        report: z
          .enum(reportsFor("keyword", "keywords"))
          .describe("Report, see mutagen://reference/reports"),
        keyword: z.string().trim().min(1).optional().describe("One phrase"),
        keywords: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(MAX_SERP_KEYWORDS)
          .optional()
          .describe("Several phrases (info and variations reports)"),
        ...reportParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_keyword_report", (args, env) =>
      runReport(env, args, { keyword: args.keyword, keywords: args.keywords }),
    ),
  );

  server.registerTool(
    "mutagen_domain_report",
    {
      title: "Mega-tool domain report",
      description: `Mega-tool reports for a site: keywords, rising and falling, new and lost, pages, subdomains, competitors, ads. ${COST}\nОтчеты по сайту.`,
      inputSchema: z.object({
        report: z.enum(reportsFor("domain")).describe("Report, see mutagen://reference/reports"),
        domain: z.string().trim().min(1).describe("Domain, e.g. example.ru"),
        subdomains: z.boolean().optional().describe("Include subdomains"),
        ...reportParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_domain_report", (args, env) =>
      runReport(
        env,
        args,
        args.subdomains ? { domain_with_subdomains: args.domain } : { domain: args.domain },
      ),
    ),
  );

  server.registerTool(
    "mutagen_page_report",
    {
      title: "Mega-tool page report",
      description: `Mega-tool reports for a page: keywords, competitors, missed keywords. ${COST}\nОтчеты по странице.`,
      inputSchema: z.object({
        report: z.enum(reportsFor("page")).describe("Report, see mutagen://reference/reports"),
        page: z.string().trim().min(1).describe("Page URL"),
        ...reportParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_page_report", (args, env) =>
      runReport(env, args, { page: args.page }),
    ),
  );

  server.registerTool(
    "mutagen_serp_report",
    {
      title: "Raw mutagen.serp.report",
      description: `Any mutagen.serp.report with full filters, for advanced use; give exactly one object field. ${COST}\nЛюбой отчет serp.report с фильтрами — для опытных.`,
      inputSchema: z.object({
        report: z.enum(REPORT_NAMES as [ReportName, ...ReportName[]]),
        keyword: z.string().optional(),
        keywords: z.array(z.string()).max(MAX_SERP_KEYWORDS).optional(),
        domain: z.string().optional(),
        domain_with_subdomains: z.string().optional(),
        page: z.string().optional(),
        filter: z
          .array(
            z.record(z.string(), z.union([z.string(), z.number(), z.boolean().describe("or")])),
          )
          .optional()
          .describe(
            '{column, filter_type, val} | {column, filter_type:"range", min, max} | {or:1}',
          ),
        ...reportParams,
      }),
      outputSchema,
      annotations: PAID,
    },
    handler(deps, server, "mutagen_serp_report", (args, env) =>
      runReport(env, args, {
        keyword: args.keyword,
        keywords: args.keywords,
        domain: args.domain,
        domain_with_subdomains: args.domain_with_subdomains,
        page: args.page,
      }),
    ),
  );
}
