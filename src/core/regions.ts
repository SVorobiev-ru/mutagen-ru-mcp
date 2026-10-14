export interface SerpRegionInfo {
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly keywordReportsOnly: boolean;
}

export const SERP_REGIONS = [
  {
    id: "yandex_ru",
    nameRu: "Яндекс, глобальная база (только отчеты по ключу)",
    nameEn: "Yandex, global database (keyword reports only)",
    keywordReportsOnly: true,
  },
  {
    id: "yandex_msk",
    nameRu: "Яндекс, Москва",
    nameEn: "Yandex, Moscow",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_spb",
    nameRu: "Яндекс, Санкт-Петербург",
    nameEn: "Yandex, Saint Petersburg",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_minsk",
    nameRu: "Яндекс, Минск",
    nameEn: "Yandex, Minsk",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_nsk",
    nameRu: "Яндекс, Новосибирск",
    nameEn: "Yandex, Novosibirsk",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_ekb",
    nameRu: "Яндекс, Екатеринбург",
    nameEn: "Yandex, Yekaterinburg",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_rostov",
    nameRu: "Яндекс, Ростов-на-Дону",
    nameEn: "Yandex, Rostov-on-Don",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_kazan",
    nameRu: "Яндекс, Казань",
    nameEn: "Yandex, Kazan",
    keywordReportsOnly: false,
  },
  {
    id: "yandex_nn",
    nameRu: "Яндекс, Нижний Новгород",
    nameEn: "Yandex, Nizhny Novgorod",
    keywordReportsOnly: false,
  },
] as const satisfies readonly SerpRegionInfo[];

export type SerpRegion = (typeof SERP_REGIONS)[number]["id"];

export const SERP_REGION_IDS: readonly SerpRegion[] = SERP_REGIONS.map((region) => region.id);

export function isSerpRegion(value: unknown): value is SerpRegion {
  return typeof value === "string" && (SERP_REGION_IDS as readonly string[]).includes(value);
}

export interface WordstatRegionInfo {
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
}

export const WORDSTAT_REGIONS = [
  { id: "0", nameRu: "Без учета региона", nameEn: "No region" },
  { id: "225", nameRu: "Россия", nameEn: "Russia" },
  { id: "213", nameRu: "Москва", nameEn: "Moscow" },
  { id: "2", nameRu: "Санкт-Петербург", nameEn: "Saint Petersburg" },
] as const satisfies readonly WordstatRegionInfo[];

const REGION_ID_PATTERN = /^-?\d+(,-?\d+)*$/;

export function isWordstatRegionId(value: string): boolean {
  return REGION_ID_PATTERN.test(value);
}
