export interface NormalizedPhrase {
  source: string;
  text: string;
  words: string[];
  minusWords: string[];
}

const TOKEN = /\d+(?:[.,]\d+)+|[a-zа-я0-9]+(?:-[a-zа-я0-9]+)*/g;
const MINUS_WORD = /(^|\s)-(\S+)/g;
const USED = /(^|[^a-zа-я0-9])б\/у(?=$|[^a-zа-я0-9])/g;

function prepare(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е").replace(USED, "$1бу");
}

export function tokenize(text: string): string[] {
  return prepare(text).match(TOKEN) ?? [];
}

export function normalizePhrase(phrase: string): NormalizedPhrase {
  const minusWords: string[] = [];
  const rest = prepare(phrase).replace(MINUS_WORD, (_match, before: string, word: string) => {
    for (const token of tokenize(word)) if (!minusWords.includes(token)) minusWords.push(token);
    return before;
  });
  const words = tokenize(rest);
  return { source: phrase, text: words.join(" "), words, minusWords };
}

export function normalizeText(phrase: string): string {
  return normalizePhrase(phrase).text;
}
