export type ReportObject = "keyword" | "keywords" | "domain" | "domain_with_subdomains" | "page";

export const REPORT_OBJECTS: readonly ReportObject[] = [
  "keyword",
  "keywords",
  "domain",
  "domain_with_subdomains",
  "page",
];

export interface ReportInfo {
  readonly objects: readonly ReportObject[];
  readonly titleRu: string;
  readonly titleEn: string;
  readonly columns: readonly string[];
  readonly yandexRu: boolean;
}

const KEYWORD_STATS = [
  "words",
  "has_question",
  "has_toponym",
  "world_wsn",
  "world_wsqso",
  "region_wsn",
  "region_wsq",
  "region_wsqso",
  "min_bid",
  "organic_results",
];

const SERP_STATS = ["hp_count_top_10", "hp_count_top_50", "ppc_count"];

const DIRECT_FORECAST = ["first_premium", "premium", "first_place", "std"].flatMap((block) =>
  ["shows", "clicks", "bid", "budget", "ctr", "budget_bid"].map((metric) => `${block}_${metric}`),
);

const VISIBILITY = [
  "visibility",
  ...[30, 90, 180, 365].map((days) => `visibility_${days}`),
  ...[30, 90, 180, 365].map((days) => `visibility_progress_${days}`),
];

const RATING = ["rating_position_wsqso", "rating_position_keywords"];

const ADV_BLOCK = ["adv_block_path", "adv_block_title", "adv_block_text", "adv_block_links"];

const DOMAIN_STATS = [
  "domain_organic_keywords",
  "domain_organic_positions",
  "domain_organic_wsqso",
  "domain_ppc_keywords",
  "domain_ppc_advert_active",
  "domain_ppc_advert_total",
  "pages",
];

const topShares = (prefix: string, tops: readonly number[]) =>
  tops.map((top) => `${prefix}_organic_keywords_top${top}_procent`);

const TOP4 = [1, 3, 5, 10];
const TOP6 = [1, 3, 5, 10, 20, 30];

const KEYWORD_FULL = ["keyword", ...KEYWORD_STATS, ...SERP_STATS, ...DIRECT_FORECAST];
const ORGANIC_KEYWORDS = ["keyword", "position", ...KEYWORD_STATS, "domain", "page"];
const COMPETITORS = [
  "domain",
  "primary_tags",
  ...VISIBILITY,
  ...DOMAIN_STATS,
  ...topShares("domain", TOP4),
  ...RATING,
  "cross_keywords",
  "similar_keywords_procent",
];

export const YANDEX_RU_COLUMNS: readonly string[] = [
  "keyword",
  "words",
  "has_question",
  "has_toponym",
  "world_wsn",
  "world_wsqso",
];

const SITE_OBJECTS = ["domain", "domain_with_subdomains", "page"] as const;
const DOMAIN_OBJECTS = ["domain", "domain_with_subdomains"] as const;

export const REPORTS = {
  report_keyword_info: {
    objects: ["keyword", "keywords"],
    titleRu: "Статистика по ключу: частоты, ставки и прогноз Директа",
    titleEn: "Keyword statistics: frequencies, bids, Yandex Direct forecast",
    columns: KEYWORD_FULL,
    yandexRu: true,
  },
  report_keyword_tailings: {
    objects: ["keyword"],
    titleRu: "Хвосты по ключу",
    titleEn: "Keyword tails (longer phrases containing the keyword)",
    columns: KEYWORD_FULL,
    yandexRu: true,
  },
  report_keyword_questions: {
    objects: ["keyword"],
    titleRu: "Хвосты-вопросы по ключу",
    titleEn: "Question tails for the keyword",
    columns: YANDEX_RU_COLUMNS,
    yandexRu: true,
  },
  report_keyword_variations: {
    objects: ["keyword", "keywords"],
    titleRu: "Вариации ключа (словоформы и порядок слов)",
    titleEn: "Keyword variations (word forms and order)",
    columns: KEYWORD_FULL,
    yandexRu: true,
  },
  report_keyword_expansion: {
    objects: ["keyword"],
    titleRu: "Связанные фразы (LSI)",
    titleEn: "Related phrases (LSI)",
    columns: ["keyword", "similarity", "cross_pages", ...KEYWORD_STATS],
    yandexRu: false,
  },
  report_keyword_positions_organic: {
    objects: ["keyword"],
    titleRu: "Органическая выдача по ключу, топ-50",
    titleEn: "Organic search results for the keyword, top 50",
    columns: [
      "position",
      "special",
      "domain",
      "domain_position_progress",
      "pages",
      "domain_organic_keywords",
      "domain_organic_positions",
      "domain_organic_wsqso",
      "domain_ppc_keywords",
      ...topShares("domain", TOP6),
      ...RATING,
      ...VISIBILITY,
      "page",
      "page_position_progress",
      "page_organic_wsqso",
      "page_organic_keywords",
      ...topShares("page", TOP6),
    ],
    yandexRu: false,
  },
  report_keyword_positions_ppc: {
    objects: ["keyword"],
    titleRu: "Рекламодатели в контексте по ключу",
    titleEn: "Advertisers in paid search for the keyword",
    columns: [
      "domain",
      "domain_organic_wsqso",
      "domain_organic_keywords",
      "domain_organic_positions",
      "domain_ppc_keywords",
      "pages",
      ...topShares("domain", TOP6),
      ...RATING,
      ...VISIBILITY,
      ...ADV_BLOCK,
    ],
    yandexRu: false,
  },
  report_keywords_organic: {
    objects: SITE_OBJECTS,
    titleRu: "Ключи сайта или страницы в органике",
    titleEn: "Organic keywords of a site or page",
    columns: [...ORGANIC_KEYWORDS, "position_progress"],
    yandexRu: false,
  },
  report_keywords_organic_down: {
    objects: SITE_OBJECTS,
    titleRu: "Упавшие ключи сайта или страницы в органике",
    titleEn: "Organic keywords that dropped in rankings",
    columns: [...ORGANIC_KEYWORDS, "position_progress"],
    yandexRu: false,
  },
  report_keywords_organic_up: {
    objects: SITE_OBJECTS,
    titleRu: "Поднявшиеся ключи сайта или страницы в органике",
    titleEn: "Organic keywords that rose in rankings",
    columns: [...ORGANIC_KEYWORDS, "position_progress"],
    yandexRu: false,
  },
  report_keywords_organic_new: {
    objects: SITE_OBJECTS,
    titleRu: "Новые ключи сайта или страницы в органике",
    titleEn: "New organic keywords of a site or page",
    columns: ORGANIC_KEYWORDS,
    yandexRu: false,
  },
  report_keywords_organic_lost: {
    objects: SITE_OBJECTS,
    titleRu: "Потерянные ключи сайта или страницы в органике",
    titleEn: "Lost organic keywords of a site or page",
    columns: ORGANIC_KEYWORDS,
    yandexRu: false,
  },
  report_keywords_ppc: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Ключи сайта в контекстной рекламе",
    titleEn: "Paid search keywords of a site",
    columns: [
      "domain",
      "page",
      "keyword",
      ...KEYWORD_STATS,
      "ad_id",
      ...ADV_BLOCK,
      "position",
      "place",
    ],
    yandexRu: false,
  },
  report_keywords_ppc_history: {
    objects: DOMAIN_OBJECTS,
    titleRu: "История ключей сайта в контекстной рекламе",
    titleEn: "Paid search keyword history of a site",
    columns: ["domain", "keyword", "ad_id", "time"],
    yandexRu: false,
  },
  report_domain_advert: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Объявления сайта",
    titleEn: "Ads of a site",
    columns: ["domain", "page", "ad_id", ...ADV_BLOCK, "time_add"],
    yandexRu: false,
  },
  report_domain_advert_active: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Активные объявления сайта",
    titleEn: "Active ads of a site",
    columns: ["domain", "page", "ad_id", ...ADV_BLOCK, "ad_id_ppc_keywords", "keywords_list"],
    yandexRu: false,
  },
  report_domain_info: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Статистика по сайту",
    titleEn: "Site statistics",
    columns: [
      "domain",
      "primary_tags",
      ...DOMAIN_STATS,
      ...topShares("domain", TOP4),
      ...RATING,
      ...VISIBILITY,
    ],
    yandexRu: false,
  },
  report_domain_pages: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Страницы сайта",
    titleEn: "Pages of a site",
    columns: [
      "domain",
      "page",
      "page_organic_wsqso",
      "page_organic_keywords",
      ...topShares("page", TOP4),
    ],
    yandexRu: false,
  },
  report_domain_subdomains: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Поддомены сайта",
    titleEn: "Subdomains of a site",
    columns: ["domain", ...DOMAIN_STATS, ...topShares("domain", TOP4), ...RATING, ...VISIBILITY],
    yandexRu: false,
  },
  report_domain_competitors: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Конкуренты сайта в органической выдаче",
    titleEn: "Organic search competitors of a site",
    columns: COMPETITORS,
    yandexRu: false,
  },
  report_domain_competitors_ppc: {
    objects: DOMAIN_OBJECTS,
    titleRu: "Конкуренты сайта в контекстной рекламе",
    titleEn: "Paid search competitors of a site",
    columns: COMPETITORS,
    yandexRu: false,
  },
  report_page_info: {
    objects: ["page"],
    titleRu: "Статистика по странице",
    titleEn: "Page statistics",
    columns: [
      "domain",
      "page",
      "page_organic_keywords",
      "page_organic_wsqso",
      ...topShares("page", TOP4),
    ],
    yandexRu: false,
  },
  report_page_competitors: {
    objects: ["page"],
    titleRu: "Конкуренты страницы в органической выдаче",
    titleEn: "Organic search competitors of a page",
    columns: [
      "domain",
      "page",
      "page_organic_keywords",
      "page_organic_wsqso",
      ...topShares("page", TOP6),
      "domain_organic_keywords",
      "domain_organic_positions",
      "domain_organic_wsqso",
      "domain_ppc_keywords",
      "pages",
      ...topShares("domain", TOP6),
      ...RATING,
      "cross_keywords",
      "similar_keywords_procent",
    ],
    yandexRu: false,
  },
  report_page_recommended_keywords: {
    objects: ["page"],
    titleRu: "Упущенные ключи страницы (ключи страниц-конкурентов)",
    titleEn: "Missed keywords for a page (keywords of competing pages)",
    columns: ["keyword", "similarity", "cross_pages", "other_page_in_top", ...KEYWORD_STATS],
    yandexRu: false,
  },
} as const satisfies Record<string, ReportInfo>;

export type ReportName = keyof typeof REPORTS;

export type ReportObjectsOf<R extends ReportName> = (typeof REPORTS)[R]["objects"][number];

export const REPORT_NAMES = Object.keys(REPORTS) as ReportName[];

export function isReportName(value: unknown): value is ReportName {
  return typeof value === "string" && Object.hasOwn(REPORTS, value);
}

export function reportInfo(name: ReportName): ReportInfo {
  return REPORTS[name];
}
