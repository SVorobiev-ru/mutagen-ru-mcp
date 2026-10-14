const VOWELS = "аеиоуыэюя";

const PERFECTIVE_GERUND_1 = ["в", "вши", "вшись"];
const PERFECTIVE_GERUND_2 = ["ив", "ивши", "ившись", "ыв", "ывши", "ывшись"];
const ADJECTIVE = [
  "ее",
  "ие",
  "ые",
  "ое",
  "ими",
  "ыми",
  "ей",
  "ий",
  "ый",
  "ой",
  "ем",
  "им",
  "ым",
  "ом",
  "его",
  "ого",
  "ему",
  "ому",
  "их",
  "ых",
  "ую",
  "юю",
  "ая",
  "яя",
  "ою",
  "ею",
];
const PARTICIPLE_1 = ["ем", "нн", "вш", "ющ", "щ"];
const PARTICIPLE_2 = ["ивш", "ывш", "ующ"];
const REFLEXIVE = ["ся", "сь"];
const VERB_1 = ["ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны"];
const VERB_1_MORE = ["ть", "ешь", "нно"];
const VERB_2 = [
  "ила",
  "ыла",
  "ена",
  "ейте",
  "уйте",
  "ите",
  "или",
  "ыли",
  "ей",
  "уй",
  "ил",
  "ыл",
  "им",
  "ым",
  "ен",
  "ило",
  "ыло",
  "ено",
  "ят",
  "ует",
  "уют",
  "ит",
  "ыт",
  "ены",
  "ить",
  "ыть",
  "ишь",
  "ую",
  "ю",
];
const NOUN = [
  "а",
  "ев",
  "ов",
  "ие",
  "ье",
  "е",
  "иями",
  "ями",
  "ами",
  "еи",
  "ии",
  "и",
  "ией",
  "ей",
  "ой",
  "ий",
  "й",
  "иям",
  "ям",
  "ием",
  "ем",
  "ам",
  "ом",
  "о",
  "у",
  "ах",
  "иях",
  "ях",
  "ы",
  "ь",
  "ию",
  "ью",
  "ю",
  "ия",
  "ья",
  "я",
];

interface Group {
  suffixes: string[];
  afterAYa: boolean;
}

const PERFECTIVE_GERUND: Group[] = [
  { suffixes: PERFECTIVE_GERUND_1, afterAYa: true },
  { suffixes: PERFECTIVE_GERUND_2, afterAYa: false },
];
const PARTICIPLE: Group[] = [
  { suffixes: PARTICIPLE_1, afterAYa: true },
  { suffixes: PARTICIPLE_2, afterAYa: false },
];
const VERB: Group[] = [
  { suffixes: [...VERB_1, ...VERB_1_MORE], afterAYa: true },
  { suffixes: VERB_2, afterAYa: false },
];

function isVowel(char: string | undefined): boolean {
  return char !== undefined && VOWELS.includes(char);
}

function goPast(word: string, from: number, vowel: boolean): number {
  let index = from;
  while (index < word.length && isVowel(word[index]) !== vowel) index += 1;
  return index < word.length ? index + 1 : word.length;
}

function regions(word: string): { rv: number; r2: number } {
  const rv = goPast(word, 0, true);
  const r1 = goPast(word, rv, false);
  return { rv, r2: goPast(word, goPast(word, r1, true), false) };
}

function longestSuffix(word: string, limit: number, suffixes: readonly string[]): string {
  let best = "";
  for (const suffix of suffixes) {
    if (
      suffix.length > best.length &&
      word.length - suffix.length >= limit &&
      word.endsWith(suffix)
    ) {
      best = suffix;
    }
  }
  return best;
}

/** Snowball's `among` picks the longest suffix across groups; a failed condition does not fall back. */
function removeGroup(word: string, limit: number, groups: readonly Group[]): string | undefined {
  let best = "";
  let bestGroup: Group | undefined;
  for (const group of groups) {
    const suffix = longestSuffix(word, limit, group.suffixes);
    if (suffix.length > best.length) {
      best = suffix;
      bestGroup = group;
    }
  }
  if (bestGroup === undefined) return undefined;
  const rest = word.slice(0, word.length - best.length);
  if (bestGroup.afterAYa) {
    const last = rest[rest.length - 1];
    if (rest.length <= limit || (last !== "а" && last !== "я")) return undefined;
  }
  return rest;
}

function removeAdjectival(word: string, limit: number): string | undefined {
  const suffix = longestSuffix(word, limit, ADJECTIVE);
  if (suffix === "") return undefined;
  const rest = word.slice(0, word.length - suffix.length);
  return removeGroup(rest, limit, PARTICIPLE) ?? rest;
}

function removeSimple(
  word: string,
  limit: number,
  suffixes: readonly string[],
): string | undefined {
  const suffix = longestSuffix(word, limit, suffixes);
  return suffix === "" ? undefined : word.slice(0, word.length - suffix.length);
}

function stemCyrillic(input: string): string {
  const { rv, r2 } = regions(input);
  let word = input;

  const gerund = removeGroup(word, rv, PERFECTIVE_GERUND);
  if (gerund !== undefined) {
    word = gerund;
  } else {
    word = removeSimple(word, rv, REFLEXIVE) ?? word;
    word =
      removeAdjectival(word, rv) ??
      removeGroup(word, rv, VERB) ??
      removeSimple(word, rv, NOUN) ??
      word;
  }

  if (word.length > rv && word.endsWith("и")) word = word.slice(0, -1);

  const derivational = longestSuffix(word, rv, ["ост", "ость"]);
  if (derivational !== "" && word.length - derivational.length >= r2) {
    word = word.slice(0, word.length - derivational.length);
  }

  const superlative = longestSuffix(word, rv, ["ейш", "ейше"]);
  if (superlative !== "") {
    word = word.slice(0, word.length - superlative.length);
    if (word.length - 2 >= rv && word.endsWith("нн")) word = word.slice(0, -1);
  } else if (word.length - 2 >= rv && word.endsWith("нн")) {
    word = word.slice(0, -1);
  } else if (word.length > rv && word.endsWith("ь")) {
    word = word.slice(0, -1);
  }
  return word;
}

/**
 * Snowball Russian stemmer (https://snowballstem.org/algorithms/russian/stemmer.html).
 * Words with characters outside а-я are returned lower-cased as is; hyphenated words
 * are stemmed part by part.
 */
export function stem(word: string): string {
  const lower = word.toLowerCase().replaceAll("ё", "е");
  if (lower.includes("-")) return lower.split("-").map(stemPart).join("-");
  return stemPart(lower);
}

function stemPart(part: string): string {
  return /^[а-я]+$/.test(part) ? stemCyrillic(part) : part;
}

const CONSONANTS = "бвгджзклмнпрстфхцчшщ";

/**
 * Comparison key of a word: its stem without a fleeting «о»/«е» before the last consonant
 * (потолок → потолк, окон → окн), so such forms match. Not meant for display.
 */
export function compareStem(word: string): string {
  const base = stem(word);
  if (base.length < 4) return base;
  const [before, vowel, last] = base.slice(-3);
  if (
    before !== undefined &&
    last !== undefined &&
    CONSONANTS.includes(before) &&
    (vowel === "о" || vowel === "е") &&
    CONSONANTS.includes(last)
  ) {
    return base.slice(0, -2) + last;
  }
  return base;
}
