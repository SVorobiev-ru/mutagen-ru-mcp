const PREPOSITIONS = [
  "в",
  "во",
  "на",
  "над",
  "под",
  "подо",
  "по",
  "о",
  "об",
  "обо",
  "от",
  "ото",
  "из",
  "изо",
  "из-за",
  "из-под",
  "к",
  "ко",
  "с",
  "со",
  "у",
  "за",
  "до",
  "для",
  "без",
  "безо",
  "при",
  "про",
  "через",
  "перед",
  "передо",
  "пред",
  "между",
  "меж",
  "около",
  "возле",
  "вокруг",
  "после",
  "кроме",
  "вместо",
  "среди",
  "сквозь",
  "вдоль",
  "мимо",
  "ради",
  "сверх",
  "против",
  "насчет",
  "вроде",
  "вне",
  "внутри",
  "благодаря",
  "согласно",
  "вопреки",
  "навстречу",
  "по-над",
];

const CONJUNCTIONS = [
  "и",
  "а",
  "но",
  "да",
  "или",
  "либо",
  "то",
  "чтобы",
  "чтоб",
  "если",
  "хотя",
  "хоть",
  "будто",
  "словно",
  "тоже",
  "также",
  "зато",
  "однако",
  "причем",
  "притом",
];

const PARTICLES = [
  "же",
  "ж",
  "бы",
  "б",
  "ли",
  "ль",
  "вот",
  "вон",
  "ведь",
  "уж",
  "лишь",
  "только",
  "даже",
  "разве",
  "неужели",
  "ка",
  "де",
  "мол",
  "дескать",
];

/**
 * Russian function words ignored when phrases are compared "without stop words".
 * Question words and the negations «не»/«ни» are kept: they change the search intent.
 */
export const RUSSIAN_STOPWORDS: ReadonlySet<string> = new Set([
  ...PREPOSITIONS,
  ...CONJUNCTIONS,
  ...PARTICLES,
]);

export function isStopword(word: string): boolean {
  return RUSSIAN_STOPWORDS.has(word.toLowerCase().replaceAll("ё", "е"));
}

const PREPOSITION_SET: ReadonlySet<string> = new Set(PREPOSITIONS);

export function isPreposition(word: string): boolean {
  return PREPOSITION_SET.has(word.toLowerCase().replaceAll("ё", "е"));
}

export function significantWords(words: readonly string[]): string[] {
  return words.filter((word) => !isStopword(word));
}
