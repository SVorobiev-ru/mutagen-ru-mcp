import { validationError } from "../core/errors.js";
import { normalizePhrase } from "./normalize.js";
import { compareStem, stem } from "./stem.js";
import { isStopword } from "./stopwords.js";

export interface PhraseItem {
  phrase: string;
  frequency?: number;
}

export type PhraseInput = string | PhraseItem;

export interface PreparedPhrase {
  item: PhraseItem;
  text: string;
  words: string[];
  stems: string[];
  frequency: number;
}

export function toPhraseItem(input: PhraseInput): PhraseItem {
  const item = typeof input === "string" ? { phrase: input } : input;
  if (typeof item?.phrase !== "string") {
    throw validationError(
      "Phrase must be a string or an object with a phrase string",
      "Фраза должна быть строкой или объектом с полем phrase.",
      "A phrase must be a string or an object with a phrase field.",
    );
  }
  const frequency = item.frequency;
  if (frequency !== undefined && (!Number.isFinite(frequency) || frequency < 0)) {
    throw validationError(
      `Invalid frequency for phrase "${item.phrase}": ${String(frequency)}`,
      `Неверная частота у фразы «${item.phrase}»: ${String(frequency)}. Нужно неотрицательное число.`,
      `Invalid frequency for phrase "${item.phrase}": ${String(frequency)}. Expected a non-negative number.`,
    );
  }
  return item;
}

function significantStems(words: readonly string[], stemmer: (word: string) => string): string[] {
  const significant = words.filter((word) => !isStopword(word));
  const source = significant.length > 0 ? significant : words;
  return [...new Set(source.map(stemmer))].sort(compareText);
}

/** Sorted unique stems of significant words; all words if the phrase has only stop words. */
export function phraseStems(words: readonly string[]): string[] {
  return significantStems(words, stem);
}

/** Like {@link phraseStems} with {@link compareStem}: the key for implicit duplicates. */
export function compareStems(words: readonly string[]): string[] {
  return significantStems(words, compareStem);
}

export function phraseKey(phrase: string): string {
  return compareStems(normalizePhrase(phrase).words).join(" ");
}

export function preparePhrase(input: PhraseInput): PreparedPhrase {
  const item = toPhraseItem(input);
  const { text, words } = normalizePhrase(item.phrase);
  return { item, text, words, stems: compareStems(words), frequency: item.frequency ?? 0 };
}

export function preparePhrases(inputs: readonly PhraseInput[]): PreparedPhrase[] {
  const prepared: PreparedPhrase[] = [];
  for (const input of inputs) {
    const phrase = preparePhrase(input);
    if (phrase.words.length > 0) prepared.push(phrase);
  }
  return prepared;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Higher frequency first, then fewer words, shorter text, and text order for a stable result. */
export function compareRank(a: PreparedPhrase, b: PreparedPhrase): number {
  return (
    b.frequency - a.frequency ||
    a.words.length - b.words.length ||
    a.text.length - b.text.length ||
    compareText(a.text, b.text) ||
    compareText(a.item.phrase, b.item.phrase)
  );
}

export function formsByCount(forms: ReadonlyMap<string, number>): string[] {
  return [...forms].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([form]) => form);
}

export function sumFrequency(phrases: readonly PreparedPhrase[]): number {
  let total = 0;
  for (const phrase of phrases) total += phrase.frequency;
  return total;
}

/** Keeps the `limit` best-ranked phrases in `top`, sorted by rank. */
export function pushTop(top: PreparedPhrase[], phrase: PreparedPhrase, limit: number): void {
  if (limit <= 0) return;
  const last = top[top.length - 1];
  if (top.length >= limit && last !== undefined && compareRank(phrase, last) >= 0) return;
  let index = top.length;
  while (index > 0 && compareRank(phrase, top[index - 1] as PreparedPhrase) < 0) index -= 1;
  top.splice(index, 0, phrase);
  if (top.length > limit) top.pop();
}

export function exampleLimit(value: number | undefined, fallback = 3): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw validationError(
      `Invalid examples limit: ${String(value)}`,
      `Неверное число примеров: ${String(value)}. Нужно целое число от 0.`,
      `Invalid examples limit: ${String(value)}. Expected an integer of 0 or more.`,
    );
  }
  return value;
}
