import type { ResultTable } from "../tables/types.js";
import { table } from "../tables/types.js";
import { buildDictionary } from "../text/dictionary.js";
import { type DuplicateMode, groupDuplicates, removeDuplicates } from "../text/duplicates.js";
import { type PhraseInput, toPhraseItem } from "../text/phrases.js";
import { findQuestions } from "../text/questions.js";
import { charCount, combinator, compareLists, filterByMask, wordCount } from "../text/tools.js";
import { invalid, num, str } from "./common.js";

export const TEXT_OPERATIONS = [
  "dedupe",
  "implicit_duplicates",
  "dictionary",
  "combinator",
  "compare",
  "filter",
  "questions",
  "count",
] as const;

export type TextOperation = (typeof TEXT_OPERATIONS)[number];

export interface TextParams {
  operation: TextOperation;
  phrases?: readonly PhraseInput[] | undefined;
  phrasesB?: readonly string[] | undefined;
  lists?: readonly (readonly string[])[] | undefined;
  mode?: DuplicateMode | undefined;
  implicit?: boolean | undefined;
  include?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
  regex?: string | undefined;
  minWords?: number | undefined;
  maxWords?: number | undefined;
  examples?: number | undefined;
}

export interface TextResult {
  table: ResultTable;
  summary: Record<string, number>;
}

const PHRASE = str("phrase", "Фраза");
const FREQUENCY = num("frequency", "Частота");

function required<T>(name: string, value: readonly T[] | undefined): readonly T[] {
  if (!value?.length) {
    throw invalid(name, "передайте непустой список.", "pass a non-empty list.");
  }
  return value;
}

function phraseRows(items: readonly PhraseInput[]) {
  return items.map((input) => {
    const item = toPhraseItem(input);
    return { phrase: item.phrase, frequency: item.frequency ?? null };
  });
}

function phraseText(input: PhraseInput): string {
  return toPhraseItem(input).phrase;
}

/** Local phrase processing, free and offline. */
export function textOperation(params: TextParams): TextResult {
  switch (params.operation) {
    case "dedupe": {
      const phrases = required("phrases", params.phrases);
      const kept = removeDuplicates(phrases, { mode: params.mode ?? "explicit" });
      return {
        table: table([PHRASE, FREQUENCY], phraseRows(kept)),
        summary: {
          input: phrases.length,
          output: kept.length,
          removed: phrases.length - kept.length,
        },
      };
    }
    case "implicit_duplicates": {
      const groups = groupDuplicates(required("phrases", params.phrases), {
        mode: params.mode ?? "implicit",
      });
      const rows = groups.flatMap((group) =>
        group.phrases.map((item, index) => ({
          group: group.representative.phrase,
          phrase: item.phrase,
          frequency: item.frequency ?? null,
          is_representative: index === 0,
        })),
      );
      return {
        table: table(
          [
            str("group", "Группа"),
            PHRASE,
            FREQUENCY,
            { key: "is_representative", title: "Оставить", type: "boolean" },
          ],
          rows,
        ),
        summary: { groups: groups.length, duplicates: rows.length - groups.length },
      };
    }
    case "dictionary": {
      const entries = buildDictionary(required("phrases", params.phrases), {
        ...(params.examples === undefined ? {} : { examples: params.examples }),
      });
      return {
        table: table(
          [
            str("word", "Слово"),
            str("forms", "Словоформы"),
            num("phrases", "Фраз"),
            num("frequency", "Сумма частот"),
            str("examples", "Примеры"),
          ],
          entries.map((entry) => ({
            word: entry.word,
            forms: entry.forms.join(", "),
            phrases: entry.phrases,
            frequency: entry.frequency,
            examples: entry.examples.join("; "),
          })),
        ),
        summary: { words: entries.length },
      };
    }
    case "combinator": {
      const phrases = combinator(required("lists", params.lists));
      return {
        table: table(
          [PHRASE],
          phrases.map((phrase) => ({ phrase })),
        ),
        summary: { phrases: phrases.length },
      };
    }
    case "compare": {
      const a = required("phrases", params.phrases).map(phraseText);
      const b = required("phrasesB", params.phrasesB);
      const result = compareLists(a, b, { implicit: params.implicit === true });
      const rows = [
        ...result.both.map((phrase) => ({ phrase, list: "both" })),
        ...result.onlyA.map((phrase) => ({ phrase, list: "only_a" })),
        ...result.onlyB.map((phrase) => ({ phrase, list: "only_b" })),
      ];
      return {
        table: table([PHRASE, str("list", "Где есть")], rows),
        summary: {
          both: result.both.length,
          onlyA: result.onlyA.length,
          onlyB: result.onlyB.length,
        },
      };
    }
    case "filter": {
      const phrases = required("phrases", params.phrases);
      const kept = filterByMask(phrases, {
        ...(params.include ? { include: params.include } : {}),
        ...(params.exclude ? { exclude: params.exclude } : {}),
        ...(params.regex === undefined ? {} : { regex: params.regex }),
        ...(params.minWords === undefined ? {} : { minWords: params.minWords }),
        ...(params.maxWords === undefined ? {} : { maxWords: params.maxWords }),
      });
      return {
        table: table([PHRASE, FREQUENCY], phraseRows(kept)),
        summary: { input: phrases.length, output: kept.length },
      };
    }
    case "questions": {
      const questions = findQuestions(required("phrases", params.phrases));
      return {
        table: table(
          [PHRASE, FREQUENCY, str("type", "Тип вопроса"), str("marker", "Вопросительное слово")],
          questions.map((item) => ({
            phrase: item.phrase,
            frequency: item.frequency ?? null,
            type: item.type,
            marker: item.marker,
          })),
        ),
        summary: { questions: questions.length },
      };
    }
    case "count": {
      const phrases = required("phrases", params.phrases).map(phraseText);
      const rows = phrases.map((phrase) => ({
        phrase,
        words: wordCount(phrase),
        chars: charCount(phrase),
        chars_no_spaces: charCount(phrase, { spaces: false }),
      }));
      return {
        table: table(
          [
            PHRASE,
            num("words", "Слов"),
            num("chars", "Символов"),
            num("chars_no_spaces", "Без пробелов"),
          ],
          rows,
        ),
        summary: {
          phrases: rows.length,
          words: rows.reduce((sum, row) => sum + row.words, 0),
          chars: rows.reduce((sum, row) => sum + row.chars, 0),
        },
      };
    }
    default:
      throw invalid(
        "operation",
        `допустимо ${TEXT_OPERATIONS.join(", ")}.`,
        `use one of ${TEXT_OPERATIONS.join(", ")}.`,
      );
  }
}
