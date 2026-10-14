import type { GetPromptResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const ESTIMATE_FIRST =
  "Сначала вызови инструмент с dry_run: true и покажи пользователю смету (рубли и запросы квоты) и план. Запускай без dry_run только после его согласия; если вернется confirm_token, повтори тот же вызов с ним только после явного «да».";

function message(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

function budgetText(budget: string | undefined): string {
  return budget
    ? `Бюджет: не больше ${budget} ₽.`
    : "Бюджет спроси у пользователя до первого платного вызова.";
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "build-core",
    {
      title: "Собрать семантическое ядро",
      description: "Semantic core for a niche within a budget / Ядро по нише в пределах бюджета",
      argsSchema: z.object({
        niche: z.string().describe("Ниша или 1–20 маркеров через запятую"),
        budget_rub: z.string().optional().describe("Бюджет, ₽"),
        region: z.string().optional().describe("Регион Вордстата, по умолчанию 225 (Россия)"),
      }),
    },
    ({ niche, budget_rub, region }) =>
      message(
        [
          `Собери семантическое ядро для ниши «${niche}» через Мутаген. ${budgetText(budget_rub)} Регион Вордстата: ${region ?? "225"}.`,
          "Шаги:",
          "1. Предложи 3–10 маркеров (короткие фразы ниши) и согласуй их с пользователем.",
          "2. mutagen_build_core с seeds, budget_rub, region; source auto (без подписки сам перейдет на Вордстат). " +
            ESTIMATE_FIRST,
          "3. Покажи итог: сколько фраз и кластеров, что отброшено (минус-слова, дубли), предупреждения; если результат частичный — скажи об этом.",
          "4. Предложи сохранить ядро (save_as: core.xlsx) и при желании mutagen_title_h1 для главных кластеров.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "expand-core",
    {
      title: "Расширить ядро",
      description: "Expand an existing core with new phrases / Расширить готовое ядро",
      argsSchema: z.object({
        core: z.string().optional().describe("Файл ядра или список фраз"),
        budget_rub: z.string().optional().describe("Бюджет, ₽"),
      }),
    },
    ({ core, budget_rub }) =>
      message(
        [
          `Расширь существующее семантическое ядро${core ? ` (${core})` : ""} новыми фразами через Мутаген. ${budgetText(budget_rub)}`,
          "Шаги:",
          "1. Получи фразы ядра (с частотами, если есть) и передай их в mutagen_expand_core как phrases; маркеры по умолчанию — главные фразы кластеров ядра.",
          `2. ${ESTIMATE_FIRST}`,
          "3. Покажи только новые фразы с частотой и кластером, сохрани их в файл (save_as) и предложи mutagen_minus_words для чистки.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "direct-prep",
    {
      title: "Подготовить Директ",
      description:
        "Negative keywords and frequencies for Yandex Direct / Минус-слова и частоты для Директа",
      argsSchema: z.object({
        niche: z.string().describe("Маркеры кампании через запятую"),
        budget_rub: z.string().optional().describe("Бюджет, ₽"),
        region: z.string().optional().describe("Регион Вордстата"),
      }),
    },
    ({ niche, budget_rub, region }) =>
      message(
        [
          `Подготовь семантику для Яндекс.Директа по маркерам «${niche}». ${budgetText(budget_rub)} Регион: ${region ?? "225"}.`,
          "Шаги:",
          "1. mutagen_minus_words с seeds и budget_rub: кандидаты в минус-слова по категориям и готовая строка «-слово -слово». " +
            ESTIMATE_FIRST,
          "2. Покажи строку минус-слов и спорные слова отдельно: решение по ним за пользователем.",
          '3. Для целевых фраз — mutagen_frequency с types ["wordstat_q", "wordstat_qs"] и, если нужно, mutagen_direct_bids; тоже сначала dry_run.',
          "4. Сохрани результат в файл (save_as) и кратко опиши, какие фразы взять в кампанию.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "content-plan",
    {
      title: "Контент-план",
      description: "Article plan from question phrases / Контент-план из вопросов",
      argsSchema: z.object({
        topic: z.string().describe("Тема или маркеры через запятую"),
        budget_rub: z.string().optional().describe("Бюджет, ₽"),
      }),
    },
    ({ topic, budget_rub }) =>
      message(
        [
          `Составь контент-план статей по теме «${topic}» через Мутаген. ${budgetText(budget_rub)}`,
          "Шаги:",
          "1. mutagen_content_plan с seeds и budget_rub; source auto (вопросы из Мега-инструмента, без подписки — из Вордстата). " +
            ESTIMATE_FIRST,
          "2. Покажи темы по убыванию суммарной частоты: заголовок, главный запрос, подвопросы.",
          "3. Для выбранных тем предложи mutagen_title_h1 и сохрани план в файл (save_as: plan.xlsx).",
        ].join("\n"),
      ),
  );
}
