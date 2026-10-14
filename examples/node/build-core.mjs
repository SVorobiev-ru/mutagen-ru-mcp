#!/usr/bin/env node
// Семантическое ядро по маркерам через библиотеку mutagen-ru-mcp.
//
//   npm install mutagen-ru-mcp
//   MUTAGEN_API_KEY=... node build-core.mjs "натяжные потолки" "потолки под ключ"
//
// CORE_BUDGET_RUB — бюджет сценария (по умолчанию 15), CORE_OUTPUT — файл .xlsx/.csv/.json,
// DRY_RUN=1 — только смета, без обращений к API.

import {
  BudgetError,
  buildCore,
  loadConfig,
  MutagenError,
  MutagenSession,
  writeTable,
} from "mutagen-ru-mcp";

const seeds = process.argv.slice(2);
if (seeds.length === 0) {
  console.error('Usage: node build-core.mjs "маркер" ["маркер" ...]');
  process.exit(2);
}

const budgetRub = Number(process.env.CORE_BUDGET_RUB ?? 15);
const output = process.env.CORE_OUTPUT ?? "core.xlsx";
const dryRun = process.env.DRY_RUN === "1";
const params = { seeds, budgetRub, region: "225" };

try {
  const session = MutagenSession.fromConfig(loadConfig());

  let result;
  try {
    result = await buildCore(session, params, { dryRun });
  } catch (error) {
    if (!(error instanceof BudgetError) || error.kind !== "needs_confirmation") throw error;
    // Смета выше MUTAGEN_AUTO_APPROVE_RUB. Скрипт неинтерактивный, поэтому подтверждает ее сам:
    // предел трат задают budgetRub и MUTAGEN_BUDGET_RUB.
    console.error(`Смета ${error.estimate.totalRub} ₽, подтверждаю.`);
    result = await buildCore(session, params, { confirmToken: error.confirmToken });
  }

  for (const warning of result.warnings) console.error(`Предупреждение: ${warning}`);

  if (result.dryRun) {
    console.log(`Смета: ${result.estimate.totalRub} ₽. API не вызывалось.`);
  } else {
    const saved = await writeTable(result.table, output);
    console.log(
      `Фраз: ${result.summary.phrases}, кластеров: ${result.summary.clusters}, ` +
        `потрачено: ${result.spentRub} ₽. Файл: ${saved.path}`,
    );
    if (result.processing) {
      console.log(
        "Часть задач еще считается у Мутагена. Запустите скрипт еще раз: повтор бесплатный.",
      );
    }
  }
} catch (error) {
  if (error instanceof MutagenError || error instanceof BudgetError) {
    console.error(error.hintRu);
    process.exit(1);
  }
  throw error;
}
