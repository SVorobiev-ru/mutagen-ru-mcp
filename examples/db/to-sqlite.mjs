#!/usr/bin/env node
// JSON-выгрузка mutagen-ru → таблица SQLite с датой сбора. Нужен Node 22.13+ или 24
// (встроенный node:sqlite), зависимостей нет.
//
//   mutagen-ru core "натяжные потолки" --budget 20 --yes -o core.json
//   node to-sqlite.mjs core.json semantic.db
//
// Каждый запуск добавляет срез: история частот по фразе — одним запросом
//   SELECT collected_at, base FROM keywords WHERE phrase = 'натяжной потолок цена';

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [input, dbPath] = process.argv.slice(2);
if (!input || !dbPath) {
  console.error("Usage: node to-sqlite.mjs <export.json> <database.db>");
  process.exit(2);
}

const { meta, rows } = JSON.parse(readFileSync(input, "utf8"));
const collectedAt = meta?.generatedAt ?? new Date().toISOString();
const EXACT_TYPES = ["wordstat_qs", "wordstat_qso", "wordstat_q", "wordstat_qo", "wordstat_no"];

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS keywords (
    collected_at TEXT NOT NULL,
    phrase TEXT NOT NULL,
    base INTEGER,
    exact INTEGER,
    cluster TEXT,
    seed TEXT,
    source TEXT NOT NULL DEFAULT 'mutagen.ru',
    data TEXT NOT NULL,
    PRIMARY KEY (collected_at, phrase)
  )
`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO keywords (collected_at, phrase, base, exact, cluster, seed, data)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

db.exec("BEGIN");
for (const row of rows) {
  const exact = EXACT_TYPES.map((type) => row[type]).find((value) => value !== undefined);
  insert.run(
    collectedAt,
    row.phrase,
    row.base ?? row.frequency ?? row.wordstat_n ?? null,
    exact ?? null,
    row.cluster ?? null,
    row.seed ?? null,
    JSON.stringify(row),
  );
}
db.exec("COMMIT");
db.close();
console.log(`${rows.length} rows → ${dbPath} (${collectedAt})`);
