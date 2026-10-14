import { validationError } from "../core/errors.js";
import { normalizePhrase, tokenize } from "./normalize.js";
import { compareStems, type PhraseInput, toPhraseItem } from "./phrases.js";
import { stem } from "./stem.js";

export const MAX_COMBINATIONS = 100_000;

/**
 * Cartesian product of word lists joined by spaces. An empty string in a list makes the slot
 * optional; repeated results are dropped.
 */
export function combinator(lists: readonly (readonly string[])[]): string[] {
  if (lists.length === 0 || lists.some((list) => list.length === 0)) return [];
  const total = lists.reduce((product, list) => product * list.length, 1);
  if (total > MAX_COMBINATIONS) {
    throw validationError(
      `Combinator would produce ${total} phrases, the limit is ${MAX_COMBINATIONS}`,
      `Комбинатор дал бы ${total} фраз, допустимо не больше ${MAX_COMBINATIONS}. Сократите списки.`,
      `The combinator would produce ${total} phrases, the limit is ${MAX_COMBINATIONS}. Shorten the lists.`,
    );
  }
  let results = [""];
  for (const list of lists) {
    const parts = list.map((part) => part.trim().replace(/\s+/g, " "));
    const next: string[] = [];
    for (const prefix of results) {
      for (const part of parts) {
        next.push(prefix === "" ? part : part === "" ? prefix : `${prefix} ${part}`);
      }
    }
    results = next;
  }
  return [...new Set(results)].filter((phrase) => phrase !== "");
}

export interface CompareListsResult {
  onlyA: string[];
  onlyB: string[];
  both: string[];
}

function listKeys(phrases: readonly string[], implicit: boolean): Map<string, string> {
  const keys = new Map<string, string>();
  for (const phrase of phrases) {
    const { text, words } = normalizePhrase(phrase);
    const key = implicit ? compareStems(words).join(" ") : text;
    if (key !== "" && !keys.has(key)) keys.set(key, phrase);
  }
  return keys;
}

/** Compares lists by normalized phrases, or by implicit duplicates with `implicit: true`. */
export function compareLists(
  a: readonly string[],
  b: readonly string[],
  options: { implicit?: boolean } = {},
): CompareListsResult {
  const keysA = listKeys(a, options.implicit === true);
  const keysB = listKeys(b, options.implicit === true);
  const result: CompareListsResult = { onlyA: [], onlyB: [], both: [] };
  for (const [key, phrase] of keysA) (keysB.has(key) ? result.both : result.onlyA).push(phrase);
  for (const [key, phrase] of keysB) if (!keysA.has(key)) result.onlyB.push(phrase);
  return result;
}

export interface MaskOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  regex?: string;
  minWords?: number;
  maxWords?: number;
}

function stemGroups(entries: readonly string[] | undefined): string[][] {
  return (entries ?? [])
    .map((entry) => tokenize(entry).map((word) => stem(word)))
    .filter((group) => group.length > 0);
}

function compileRegex(source: string): RegExp {
  try {
    return new RegExp(source, "iu");
  } catch {
    throw validationError(
      `Invalid regex: ${source}`,
      `Неверное регулярное выражение: ${source}.`,
      `Invalid regular expression: ${source}.`,
    );
  }
}

/**
 * Filters phrases by stems: a phrase passes when it contains all words of at least one
 * `include` entry and of no `exclude` entry. `regex` is tested against the normalized phrase.
 */
export function filterByMask<T extends PhraseInput>(
  phrases: readonly T[],
  options: MaskOptions,
): T[] {
  const include = stemGroups(options.include);
  const exclude = stemGroups(options.exclude);
  const regex = options.regex === undefined ? undefined : compileRegex(options.regex);
  return phrases.filter((input) => {
    const { text, words } = normalizePhrase(toPhraseItem(input).phrase);
    if (options.minWords !== undefined && words.length < options.minWords) return false;
    if (options.maxWords !== undefined && words.length > options.maxWords) return false;
    const stems = new Set(words.map((word) => stem(word)));
    const has = (group: string[]) => group.every((item) => stems.has(item));
    if (include.length > 0 && !include.some(has)) return false;
    if (exclude.some(has)) return false;
    return regex === undefined || regex.test(text);
  });
}

export function wordCount(phrase: string): number {
  return normalizePhrase(phrase).words.length;
}

/** Characters of the raw text in code points; `spaces: false` skips whitespace. */
export function charCount(text: string, options: { spaces?: boolean } = {}): number {
  const chars = [...text];
  return options.spaces === false ? chars.filter((char) => !/\s/.test(char)).length : chars.length;
}
