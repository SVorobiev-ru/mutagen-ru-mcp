import {
  compareRank,
  compareText,
  type PhraseInput,
  type PhraseItem,
  type PreparedPhrase,
  preparePhrases,
  sumFrequency,
} from "./phrases.js";

export type DuplicateMode = "explicit" | "implicit";

export interface DuplicateGroup {
  key: string;
  representative: PhraseItem;
  phrases: PhraseItem[];
  frequency: number;
}

export interface DuplicateOptions {
  mode?: DuplicateMode;
  includeUnique?: boolean;
}

function groupKey(phrase: PreparedPhrase, mode: DuplicateMode): string {
  return mode === "explicit" ? phrase.text : phrase.stems.join(" ");
}

function compareGroups(a: DuplicateGroup, b: DuplicateGroup): number {
  return (
    b.frequency - a.frequency || b.phrases.length - a.phrases.length || compareText(a.key, b.key)
  );
}

/**
 * Explicit duplicates match after normalization; implicit ones share the set of stems of
 * significant words, so word order, word forms and stop words are ignored.
 * Phrases that normalize to nothing are skipped.
 */
export function groupDuplicates(
  phrases: readonly PhraseInput[],
  options: DuplicateOptions = {},
): DuplicateGroup[] {
  const mode = options.mode ?? "implicit";
  const groups = new Map<string, PreparedPhrase[]>();
  for (const phrase of preparePhrases(phrases)) {
    const key = groupKey(phrase, mode);
    const members = groups.get(key);
    if (members) members.push(phrase);
    else groups.set(key, [phrase]);
  }
  const result: DuplicateGroup[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2 && !options.includeUnique) continue;
    members.sort(compareRank);
    const items = members.map((member) => member.item);
    result.push({
      key,
      representative: items[0] as PhraseItem,
      phrases: items,
      frequency: sumFrequency(members),
    });
  }
  return result.sort(compareGroups);
}

/** One representative per group, in the order of the first appearance of the group. */
export function removeDuplicates(
  phrases: readonly PhraseInput[],
  options: { mode?: DuplicateMode } = {},
): PhraseItem[] {
  const mode = options.mode ?? "implicit";
  const best = new Map<string, PreparedPhrase>();
  for (const phrase of preparePhrases(phrases)) {
    const key = groupKey(phrase, mode);
    const current = best.get(key);
    if (current === undefined || compareRank(phrase, current) < 0) best.set(key, phrase);
  }
  return [...best.values()].map((phrase) => phrase.item);
}
