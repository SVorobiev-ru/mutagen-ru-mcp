import { MutagenError } from "../core/errors.js";
import type { SerpReportParams } from "../core/types.js";
import { requireText } from "../core/validate.js";
import type { MutagenSession, SerpReportResult } from "../session.js";
import { toNumber } from "../tables/mass.js";
import { table } from "../tables/types.js";
import { normalizeUrl } from "../text/cluster.js";
import { compareText, phraseKey } from "../text/phrases.js";
import {
  executed,
  intOption,
  invalid,
  missingFrequency,
  needsSubscription,
  nested,
  num,
  numberOption,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  serpRegionOf,
  str,
  unique,
} from "./common.js";

export const MAX_COMPETITORS = 10;
export const DEFAULT_COMPETITORS_TOP = 5;
export const DEFAULT_LIMIT_PER_DOMAIN = 1000;

export interface ContentGapParams {
  domain: string;
  competitors?: readonly string[] | "auto" | undefined;
  competitorsTop?: number | undefined;
  serpRegion?: string | undefined;
  minFrequency?: number | undefined;
  limitPerDomain?: number | undefined;
}

export interface ContentGapSummary {
  domain: string;
  competitors: string[];
  ownKeywords: number;
  competitorKeywords: number;
  gap: number;
}

interface GapEntry {
  phrase: string;
  frequency: number | null;
  domains: Set<string>;
  bestPosition: number | null;
  bestDomain: string;
  page: string;
}

export function domainOf(value: string): string {
  return normalizeUrl(requireText("domain", value)).split("/")[0] as string;
}

function subscriptionError(error: MutagenError): MutagenError {
  return new MutagenError({
    kind: "subscription_required",
    code: 111,
    message: error.message,
    hintRu:
      "content_gap работает только с подпиской на Мега-инструмент Мутагена: ключи сайтов берутся из отчетов report_keywords_organic. Без подписки сравните свои списки фраз бесплатно (mutagen_text, operation compare).",
    hintEn:
      "content_gap needs a Mutagen Mega-tool subscription: site keywords come from report_keywords_organic. Without it, compare your own phrase lists for free (mutagen_text, operation compare).",
  });
}

export async function contentGap(
  session: MutagenSession,
  params: ContentGapParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<ContentGapSummary>> {
  const domain = domainOf(params.domain);
  const serpRegion = serpRegionOf(params.serpRegion);
  const minFrequency = numberOption("minFrequency", params.minFrequency);
  const limit = intOption("limitPerDomain", params.limitPerDomain, DEFAULT_LIMIT_PER_DOMAIN, 1);
  const auto = params.competitors === undefined || params.competitors === "auto";
  const given = auto
    ? []
    : unique((params.competitors as readonly string[]).map(domainOf)).filter(
        (item) => item !== domain,
      );
  if (!auto && (given.length === 0 || given.length > MAX_COMPETITORS)) {
    throw invalid(
      "competitors",
      `нужно от 1 до ${MAX_COMPETITORS} доменов конкурентов или auto.`,
      `expected 1 to ${MAX_COMPETITORS} competitor domains or auto.`,
    );
  }
  const top = auto
    ? Math.min(
        intOption("competitorsTop", params.competitorsTop, DEFAULT_COMPETITORS_TOP, 1),
        MAX_COMPETITORS,
      )
    : given.length;
  const estimate = session.estimate([
    { method: "serp.report", requests: (auto ? 1 : 0) + 1 + top },
  ]);
  const settings = {
    domain,
    competitors: auto ? "auto" : given,
    top,
    serpRegion,
    minFrequency,
    limit,
  };

  const report = async (name: string, target: string, rows: number) => {
    const body = { region: serpRegion, report: name, domain: target, limit: rows };
    try {
      const result = executed<SerpReportResult>(
        await session.serpReport(body as unknown as SerpReportParams, nested(options)),
      );
      return result.rows;
    } catch (error) {
      if (needsSubscription(error)) throw subscriptionError(error as MutagenError);
      throw error;
    }
  };

  return runScenario(
    session,
    { label: "content_gap", params: settings, estimate, summary: settings, warnings: [] },
    options,
    async () => {
      const notes: string[] = [];
      let competitors = given;
      if (auto) {
        const rows = await report("report_domain_competitors", domain, top + 1);
        competitors = unique(
          rows
            .map((row) => (typeof row.domain === "string" ? domainOf(row.domain) : ""))
            .filter((item) => item !== "" && item !== domain),
        ).slice(0, top);
        if (competitors.length === 0) {
          notes.push(
            "Мутаген не нашел конкурентов домена: укажите competitors вручную. No competitors found.",
          );
        }
      }
      const [own = [], ...others] = await Promise.all(
        [domain, ...competitors].map((target) => report("report_keywords_organic", target, limit)),
      );
      const ownKeys = new Set(
        own
          .map((row) => (typeof row.keyword === "string" ? phraseKey(row.keyword) : ""))
          .filter((key) => key !== ""),
      );
      const gap = new Map<string, GapEntry>();
      let competitorKeywords = 0;
      for (const [index, rows] of others.entries()) {
        const competitor = competitors[index] as string;
        competitorKeywords += rows.length;
        for (const row of rows) {
          if (typeof row.keyword !== "string" || row.keyword.trim() === "") continue;
          const key = phraseKey(row.keyword);
          if (key === "" || ownKeys.has(key)) continue;
          const frequency = toNumber(row.region_wsn) ?? toNumber(row.world_wsn);
          const position = toNumber(row.position);
          const page = typeof row.page === "string" ? row.page : "";
          const entry = gap.get(key) ?? {
            phrase: row.keyword.trim(),
            frequency,
            domains: new Set<string>(),
            bestPosition: null,
            bestDomain: competitor,
            page,
          };
          entry.domains.add(competitor);
          if (frequency !== null && (entry.frequency === null || frequency > entry.frequency)) {
            entry.frequency = frequency;
          }
          if (position !== null && (entry.bestPosition === null || position < entry.bestPosition)) {
            entry.bestPosition = position;
            entry.bestDomain = competitor;
            entry.page = page;
          }
          gap.set(key, entry);
        }
      }
      const score = (entry: GapEntry) => (entry.frequency ?? 0) * entry.domains.size;
      const entries = [...gap.values()]
        .filter((entry) => entry.frequency === null || entry.frequency >= minFrequency)
        .sort(
          (a, b) =>
            score(b) - score(a) ||
            b.domains.size - a.domains.size ||
            compareText(a.phrase, b.phrase),
        );
      const unknown = entries.filter((entry) => entry.frequency === null).length;
      if (minFrequency > 0 && unknown > 0) notes.push(missingFrequency(unknown, "min_frequency"));
      return {
        table: table(
          [
            str("phrase", "Фраза"),
            num("frequency", "Частота"),
            num("competitors", "Конкурентов"),
            num("best_position", "Лучшая позиция"),
            str("best_competitor", "Лучший конкурент"),
            str("page", "Страница конкурента"),
            str("domains", "Конкуренты"),
          ],
          entries.map((entry) => ({
            phrase: entry.phrase,
            frequency: entry.frequency,
            competitors: entry.domains.size,
            best_position: entry.bestPosition,
            best_competitor: entry.bestDomain,
            page: entry.page,
            domains: [...entry.domains].join(", "),
          })),
          { query: domain, region: serpRegion },
        ),
        summary: {
          domain,
          competitors,
          ownKeywords: own.length,
          competitorKeywords,
          gap: entries.length,
        },
        warnings: notes,
        partial: false,
      };
    },
  );
}
