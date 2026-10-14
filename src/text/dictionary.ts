import {
  compareText,
  exampleLimit,
  formsByCount,
  type PhraseInput,
  type PreparedPhrase,
  preparePhrases,
  pushTop,
} from "./phrases.js";
import { stem } from "./stem.js";
import { isStopword } from "./stopwords.js";

export interface DictionaryEntry {
  stem: string;
  word: string;
  forms: string[];
  phrases: number;
  frequency: number;
  examples: string[];
}

export interface DictionaryOptions {
  examples?: number;
  includeStopwords?: boolean;
}

interface Accumulator {
  stem: string;
  forms: Map<string, number>;
  phrases: number;
  frequency: number;
  top: PreparedPhrase[];
}

export function buildDictionary(
  phrases: readonly PhraseInput[],
  options: DictionaryOptions = {},
): DictionaryEntry[] {
  const limit = exampleLimit(options.examples);
  const byStem = new Map<string, Accumulator>();
  for (const phrase of preparePhrases(phrases)) {
    const seen = new Set<string>();
    for (const word of phrase.words) {
      if (!options.includeStopwords && isStopword(word)) continue;
      const key = stem(word);
      let entry = byStem.get(key);
      if (entry === undefined) {
        entry = { stem: key, forms: new Map(), phrases: 0, frequency: 0, top: [] };
        byStem.set(key, entry);
      }
      entry.forms.set(word, (entry.forms.get(word) ?? 0) + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      entry.phrases += 1;
      entry.frequency += phrase.frequency;
      pushTop(entry.top, phrase, limit);
    }
  }
  return [...byStem.values()]
    .map((entry) => {
      const forms = formsByCount(entry.forms);
      return {
        stem: entry.stem,
        word: forms[0] as string,
        forms,
        phrases: entry.phrases,
        frequency: entry.frequency,
        examples: entry.top.map((phrase) => phrase.item.phrase),
      };
    })
    .sort(
      (a, b) => b.phrases - a.phrases || b.frequency - a.frequency || compareText(a.stem, b.stem),
    );
}
