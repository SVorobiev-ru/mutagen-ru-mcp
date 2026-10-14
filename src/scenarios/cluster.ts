import type { SerpReportParams, SerpRow } from "../core/types.js";
import { MAX_MASS_KEYS, requireId } from "../core/validate.js";
import type { MutagenSession, SerpReportResult } from "../session.js";
import { toNumber } from "../tables/mass.js";
import { table } from "../tables/types.js";
import {
  type Cluster,
  clusterBySerp,
  clusterLexical,
  type LexicalClusterMode,
  type SerpClusterMode,
} from "../text/cluster.js";
import { normalizeText } from "../text/normalize.js";
import { compareRank, type PhraseInput, type PhraseItem, preparePhrases } from "../text/phrases.js";
import {
  executed,
  intOption,
  invalid,
  nested,
  noData,
  num,
  phraseItems,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  serpRegionOf,
  str,
} from "./common.js";

export type ClusterMode = "lexical" | "serp" | "project";
export type ClusterStrictness = LexicalClusterMode | SerpClusterMode;

export const CLUSTER_MODES: readonly ClusterMode[] = ["lexical", "serp", "project"];
export const MAX_SERP_CLUSTER_PHRASES = 300;

export interface ClusterParams {
  phrases?: readonly PhraseInput[] | undefined;
  mode?: ClusterMode | undefined;
  strictness?: ClusterStrictness | undefined;
  threshold?: number | undefined;
  minCommon?: number | undefined;
  depth?: number | undefined;
  serpRegion?: string | undefined;
  projectId?: number | undefined;
}

export interface ClusterSummary {
  mode: ClusterMode;
  phrases: number;
  clusters: number;
  withoutSerp?: number;
}

function clusterTable(clusters: readonly Cluster[], query: string) {
  const rows = clusters.flatMap((cluster) =>
    cluster.phrases.map((item, index) => ({
      cluster: cluster.name,
      phrase: item.phrase,
      frequency: item.frequency ?? null,
      is_head: index === 0,
    })),
  );
  return table(
    [
      str("cluster", "Кластер"),
      str("phrase", "Фраза"),
      num("frequency", "Частота"),
      { key: "is_head", title: "Главная фраза", type: "boolean" },
    ],
    rows,
    { query },
  );
}

function strictnessOf(mode: ClusterMode, value: ClusterStrictness | undefined) {
  const allowed = mode === "lexical" ? ["strict", "soft"] : ["soft", "hard"];
  const strictness = value ?? "soft";
  if (!allowed.includes(strictness)) {
    throw invalid(
      "strictness",
      `для режима ${mode} допустимо ${allowed.join(" или ")}.`,
      `mode ${mode} accepts ${allowed.join(" or ")}.`,
    );
  }
  return strictness;
}

export function serpUrls(rows: readonly SerpRow[]): string[] {
  return rows
    .map((row, index) => ({
      url:
        typeof row.page === "string" && row.page !== ""
          ? row.page
          : typeof row.domain === "string"
            ? row.domain
            : "",
      position: toNumber(row.position) ?? index + 1,
    }))
    .filter((item) => item.url !== "")
    .sort((a, b) => a.position - b.position)
    .map((item) => item.url);
}

function projectClusters(
  keywords: readonly { keyword: string; claster_id: string | null }[],
  frequencies: ReadonlyMap<string, number>,
): Cluster[] {
  const groups = new Map<string, PhraseItem[]>();
  for (const [index, keyword] of keywords.entries()) {
    const id = keyword.claster_id;
    const key = id === null || id === "" || id === "0" ? `single:${index}` : `id:${id}`;
    const frequency = frequencies.get(normalizeText(keyword.keyword));
    const item =
      frequency === undefined
        ? { phrase: keyword.keyword }
        : { phrase: keyword.keyword, frequency };
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()]
    .map((group) => {
      const items = preparePhrases(group)
        .sort(compareRank)
        .map((phrase) => phrase.item);
      const main = items[0] as PhraseItem;
      const frequency = items.reduce((sum, item) => sum + (item.frequency ?? 0), 0);
      return { name: main.phrase, main, phrases: items, frequency };
    })
    .filter((cluster) => cluster.phrases.length > 0)
    .sort((a, b) => b.frequency - a.frequency || b.phrases.length - a.phrases.length);
}

/** True when the call never reaches the API: lexical clustering of the given phrases. */
export function clusterIsLocal(params: ClusterParams): boolean {
  return (params.mode ?? "lexical") === "lexical";
}

export async function cluster(
  session: MutagenSession,
  params: ClusterParams,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<ClusterSummary>> {
  const mode = params.mode ?? "lexical";
  if (!CLUSTER_MODES.includes(mode)) {
    throw invalid("mode", "допустимо lexical, serp или project.", "use lexical, serp or project.");
  }
  if (mode === "project") {
    if (params.projectId === undefined) {
      throw invalid(
        "projectId",
        "для режима project укажите id проекта: он в адресе страницы проекта в кабинете Мутагена (Избранное → проект).",
        "mode project needs the project id: it is in the project page URL in the Mutagen account (Избранное → project).",
      );
    }
    const projectId = requireId("projectId", params.projectId);
    const given = params.phrases?.length ? phraseItems(params.phrases, MAX_MASS_KEYS) : [];
    const frequencies = new Map<string, number>();
    for (const item of given) {
      if (item.frequency !== undefined) frequencies.set(normalizeText(item.phrase), item.frequency);
    }
    const settings = { mode, projectId };
    return runScenario(
      session,
      {
        label: "cluster",
        params: settings,
        estimate: session.estimate([]),
        summary: settings,
        warnings: [],
      },
      options,
      async () => {
        const { keywords } = await session.projectKeywords(projectId, nested(options));
        const clusters = projectClusters(keywords, frequencies);
        return {
          table: clusterTable(clusters, `progect ${projectId}`),
          summary: { mode, phrases: keywords.length, clusters: clusters.length },
          warnings: [],
          partial: false,
        };
      },
    );
  }

  const strictness = strictnessOf(mode, params.strictness);
  if (mode === "lexical") {
    const items = phraseItems(params.phrases, MAX_MASS_KEYS);
    const settings = { mode, strictness, threshold: params.threshold };
    return runScenario(
      session,
      {
        label: "cluster",
        params: settings,
        estimate: session.estimate([]),
        summary: settings,
        warnings: [],
      },
      options,
      async () => {
        const clusters = clusterLexical(items, {
          mode: strictness as LexicalClusterMode,
          ...(params.threshold === undefined ? {} : { threshold: params.threshold }),
        });
        return {
          table: clusterTable(clusters, "lexical"),
          summary: { mode, phrases: items.length, clusters: clusters.length },
          warnings: [],
          partial: false,
        };
      },
    );
  }

  const items = phraseItems(params.phrases, MAX_SERP_CLUSTER_PHRASES);
  const serpRegion = serpRegionOf(params.serpRegion);
  const minCommon = intOption("minCommon", params.minCommon, 3, 1);
  const depth = intOption("depth", params.depth, 10, 1);
  const phrases = [...new Set(items.map((item) => item.phrase))];
  const estimate = session.estimate([{ method: "serp.report", requests: phrases.length }]);
  const settings = { mode, strictness, minCommon, depth, serpRegion, phrases };
  return runScenario(
    session,
    {
      label: "cluster",
      params: settings,
      estimate,
      summary: { mode, strictness, minCommon, depth, serpRegion, phrases: phrases.length },
      warnings: [],
    },
    options,
    async () => {
      const notes: string[] = [];
      const settled = await Promise.allSettled(
        phrases.map(async (keyword) => {
          const report = {
            region: serpRegion,
            report: "report_keyword_positions_organic",
            keyword,
          } as unknown as SerpReportParams;
          const result = executed<SerpReportResult>(
            await session.serpReport(report, nested(options)),
          );
          notes.push(...(result.warnings ?? []));
          return serpUrls(result.rows);
        }),
      );
      const urls = new Map<string, string[]>();
      let missing = 0;
      let failure: unknown;
      for (const [index, item] of settled.entries()) {
        if (item.status === "fulfilled") {
          urls.set(phrases[index] as string, item.value);
          if (item.value.length === 0) missing += 1;
        } else if (noData(item.reason)) {
          missing += 1;
        } else {
          failure ??= item.reason;
        }
      }
      if (failure !== undefined) throw failure;
      if (missing > 0) {
        notes.push(
          `Нет выдачи в базе Мутагена для ${missing} фраз: они остались отдельными кластерами. No SERP data for ${missing} phrases.`,
        );
      }
      const clusters = clusterBySerp(items, urls, {
        mode: strictness as SerpClusterMode,
        minCommon,
        depth,
      });
      return {
        table: clusterTable(clusters, "serp"),
        summary: { mode, phrases: items.length, clusters: clusters.length, withoutSerp: missing },
        warnings: notes,
        partial: false,
      };
    },
  );
}
