import type { McpServer } from "@modelcontextprotocol/server";
import { type PriceTable, resolvePrices } from "../budget/pricing.js";
import { SERP_REGIONS, WORDSTAT_REGIONS } from "../core/regions.js";
import { REPORT_NAMES, REPORTS } from "../core/reports.js";
import { SOURCE_NOTE, yesNo } from "../export/table.js";
import type { McpDeps } from "./context.js";
import { SUBSCRIPTION_URL } from "./links.js";

export function reportsMarkdown(): string {
  const sections = REPORT_NAMES.map((name) => {
    const info = REPORTS[name];
    return [
      `## ${name}`,
      `${info.titleRu} / ${info.titleEn}`,
      `- Объекты / objects: ${info.objects.join(", ")}`,
      `- yandex_ru: ${yesNo(info.yandexRu)}`,
      `- Колонки / columns: ${info.columns.join(", ")}`,
    ].join("\n");
  });
  return [
    "# Отчеты Мега-инструмента / Mega-tool reports",
    `Нужна подписка: ${SUBSCRIPTION_URL}. Каждый запрос расходует 1 запрос суточной квоты.`,
    ...sections,
    SOURCE_NOTE,
  ].join("\n\n");
}

export function regionsMarkdown(): string {
  return [
    "# Регионы / Regions",
    "## Мега-инструмент (region в отчетах)",
    "| id | Регион | Region | Только отчеты по ключу |",
    "|---|---|---|---|",
    ...SERP_REGIONS.map(
      (region) =>
        `| ${region.id} | ${region.nameRu} | ${region.nameEn} | ${yesNo(region.keywordReportsOnly)} |`,
    ),
    "",
    "## Вордстат (region в частотности, ставках и колонках)",
    'Любые id регионов Яндекса через запятую, исключение со знаком минус, например "225" или "255,-17". Частые:',
    "| id | Регион | Region |",
    "|---|---|---|",
    ...WORDSTAT_REGIONS.map((region) => `| ${region.id} | ${region.nameRu} | ${region.nameEn} |`),
    "",
    SOURCE_NOTE,
  ].join("\n");
}

export function pricesMarkdown(prices: PriceTable): string {
  return [
    "# Цены / Prices",
    "Неподтвержденные цены — предположение до живой проверки: такие вызовы всегда требуют подтверждения.",
    "| Метод | ₽ | За | Подтверждена | Проверено | Подписка | Квота | Повтор бесплатно, дней | Источник |",
    "|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(prices).map(
      ([key, price]) =>
        `| ${key} | ${price.rub.toFixed(2)} | ${price.per} | ${yesNo(price.confirmed)} | ${price.verifiedAt} | ${yesNo(price.requiresSubscription ?? false)} | ${price.quotaRequests ?? 0} | ${price.freeRepeatDays ?? ""} | ${price.source} |`,
    ),
    "",
    SOURCE_NOTE,
  ].join("\n");
}

export function registerResources(server: McpServer, deps: McpDeps): void {
  const resources = [
    ["reports", "Mega-tool reports and columns", reportsMarkdown],
    ["regions", "Regions of Mega-tool and Wordstat", regionsMarkdown],
    [
      "prices",
      "Method prices, confirmed or not",
      () => pricesMarkdown(resolvePrices(deps.config.prices)),
    ],
  ] as const;
  for (const [name, description, render] of resources) {
    const uri = `mutagen://reference/${name}`;
    server.registerResource(
      `reference-${name}`,
      uri,
      { title: description, description, mimeType: "text/markdown" },
      async () => ({ contents: [{ uri, mimeType: "text/markdown", text: render() }] }),
    );
  }
}
