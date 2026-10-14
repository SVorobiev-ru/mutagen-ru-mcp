import { normalizePhrase } from "./normalize.js";
import type { PhraseInput, PhraseItem } from "./phrases.js";
import { toPhraseItem } from "./phrases.js";

export type QuestionType =
  | "how"
  | "what"
  | "why"
  | "purpose"
  | "where"
  | "where_to"
  | "where_from"
  | "when"
  | "which"
  | "how_much"
  | "who"
  | "can"
  | "need"
  | "worth"
  | "yes_no";

export interface QuestionInfo {
  isQuestion: boolean;
  type?: QuestionType;
  marker?: string;
}

export interface QuestionPhrase extends PhraseItem {
  type: QuestionType;
  marker: string;
}

const MODAL_TYPES: Readonly<Record<string, QuestionType>> = {
  можно: "can",
  нужно: "need",
  надо: "need",
  стоит: "worth",
};

const WORD_TYPES = new Map<string, QuestionType>();
for (const [type, words] of [
  ["how", "как"],
  ["what", "что,чего,чему,чем"],
  ["why", "почему,отчего"],
  ["purpose", "зачем"],
  ["where", "где"],
  ["where_to", "куда"],
  ["where_from", "откуда"],
  ["when", "когда"],
  [
    "which",
    "какой,какая,какое,какие,какого,какую,каких,каким,какими,каком,какому,каков,какова,каково,каковы",
  ],
  ["how_much", "сколько,скольки"],
  ["who", "кто,кого,кому,кем,ком"],
] as const) {
  for (const word of words.split(",")) WORD_TYPES.set(word, type);
}

/**
 * Lexical question detection. Modal questions («можно ли», «стоит ли») win, then the first
 * question word in the phrase, then a bare «ли».
 */
export function detectQuestion(phrase: string): QuestionInfo {
  const { words } = normalizePhrase(phrase);
  for (let index = 1; index < words.length; index += 1) {
    const modal = MODAL_TYPES[words[index - 1] as string];
    if (modal !== undefined && words[index] === "ли") {
      return { isQuestion: true, type: modal, marker: `${words[index - 1]} ли` };
    }
  }
  for (const word of words) {
    const type = WORD_TYPES.get(word);
    if (type !== undefined) return { isQuestion: true, type, marker: word };
  }
  if (words.includes("ли")) return { isQuestion: true, type: "yes_no", marker: "ли" };
  return { isQuestion: false };
}

export function isQuestion(phrase: string): boolean {
  return detectQuestion(phrase).isQuestion;
}

export function findQuestions(phrases: readonly PhraseInput[]): QuestionPhrase[] {
  const result: QuestionPhrase[] = [];
  for (const input of phrases) {
    const item = toPhraseItem(input);
    const info = detectQuestion(item.phrase);
    if (info.type !== undefined && info.marker !== undefined) {
      result.push({ ...item, type: info.type, marker: info.marker });
    }
  }
  return result;
}
