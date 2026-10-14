import { isTaskPending } from "../core/errors.js";
import { regionId } from "../core/validate.js";
import type { MutagenSession } from "../session.js";
import { table } from "../tables/types.js";
import { tokenize } from "../text/normalize.js";
import {
  compareRank,
  compareStems,
  type PhraseInput,
  type PhraseItem,
  type PreparedPhrase,
  preparePhrases,
  toPhraseItem,
} from "../text/phrases.js";
import { compareStem } from "../text/stem.js";
import { isPreposition, isStopword } from "../text/stopwords.js";
import { frequencies, frequencyKey } from "./collect.js";
import {
  capitalize,
  invalid,
  isStop,
  nested,
  num,
  overBudget,
  phraseItems,
  runScenario,
  type ScenarioOptions,
  type ScenarioResult,
  stopWarning,
  str,
} from "./common.js";
import { DEFAULT_WORDSTAT_REGION } from "./core.js";

export const TITLE_MAX = 70;
export const DESCRIPTION_MAX = 160;
export const MAX_TITLE_PHRASES = 1000;

export interface TitleH1Params {
  phrases: readonly PhraseInput[];
  brand?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  budgetRub?: number | undefined;
}

export interface TitleH1Texts {
  title: string;
  h1: string;
  description: string;
  rationale: { title: string; h1: string; description: string };
}

export interface TitleH1Summary extends TitleH1Texts {
  mainPhrase: string;
  mainFrequency: number;
  frequenciesFrom: "input" | "wordstat_qs";
}

function shorten(variants: readonly string[], max: number): string {
  for (const variant of variants) if ([...variant].length <= max) return variant;
  const words = (variants[variants.length - 1] ?? "").split(" ");
  let result = "";
  for (const word of words) {
    const next = result === "" ? word : `${result} ${word}`;
    if ([...next].length > max) break;
    result = next;
  }
  return result === "" ? [...(words[0] ?? "")].slice(0, max).join("") : result;
}

function stemsOf(text: string): Set<string> {
  return new Set(tokenize(text).map((word) => compareStem(word)));
}

function quote(phrase: PreparedPhrase): string {
  return `«${phrase.text}» (${phrase.frequency})`;
}

const SAFE_TAIL_STARTS: ReadonlySet<string> = new Set([
  "цена",
  "цены",
  "стоимость",
  "купить",
  "заказать",
  "недорого",
  "дешево",
  "отзывы",
  "фото",
  "видео",
  "своими",
]);

const GEO_WORDS: ReadonlySet<string> = new Set(
  ["москва", "мск", "спб", "питер", "петербург", "санкт-петербург"].map(compareStem),
);

interface Refinement {
  text: string;
  from: PreparedPhrase;
  whole: boolean;
}

/** Trailing words of the phrase that are absent from the main phrase, in their source form. */
function tailOf(phrase: PreparedPhrase, mainStems: ReadonlySet<string>): string[] {
  let start = phrase.words.length;
  while (start > 0) {
    const word = phrase.words[start - 1] as string;
    if (!isStopword(word) && mainStems.has(compareStem(word))) break;
    start -= 1;
  }
  return phrase.words.slice(start);
}

/**
 * Refinements are whole cluster phrases or their tails, never re-inflected: a tail is used
 * only when it reads on its own (starts with a preposition, a common modifier or a word that
 * starts another phrase of the cluster).
 */
function refinementsOf(
  main: PreparedPhrase,
  ranked: readonly PreparedPhrase[],
  blocked: ReadonlySet<string>,
  limit: number,
): Refinement[] {
  const mainStems = new Set(main.stems);
  const starts = new Set(ranked.map((phrase) => phrase.words[0]));
  const tails: Refinement[] = [];
  const wholes: Refinement[] = [];
  for (const phrase of ranked.slice(1)) {
    if (main.stems.every((item) => phrase.stems.includes(item))) {
      const tail = tailOf(phrase, mainStems);
      const first = tail[0];
      if (first === undefined || tail.every((word) => isStopword(word))) continue;
      if (isPreposition(first) || SAFE_TAIL_STARTS.has(first) || starts.has(first)) {
        tails.push({ text: tail.join(" "), from: phrase, whole: false });
      }
    } else {
      wholes.push({ text: phrase.text, from: phrase, whole: true });
    }
  }
  const used = new Set([...mainStems, ...blocked]);
  const chosen: Refinement[] = [];
  for (const candidate of [...tails, ...wholes]) {
    if (chosen.length >= limit) break;
    const stems = compareStems(tokenize(candidate.text)).filter((item) => !mainStems.has(item));
    if (stems.length === 0 || stems.some((item) => used.has(item))) continue;
    for (const item of stems) used.add(item);
    chosen.push(candidate);
  }
  return chosen;
}

function describeRefinement(refinement: Refinement): string {
  return refinement.whole
    ? `фраза ${quote(refinement.from)}`
    : `«${refinement.text}» из ${quote(refinement.from)}`;
}

/**
 * Title: the most frequent phrase, a dash and 1–2 refinements taken verbatim from other phrases;
 * H1: the next formulation with a different comparison key; Description: the main phrase, the
 * refinements and a call to action. No word is re-inflected. Deterministic for the same input.
 */
export function composeTitleH1(
  phrases: readonly PhraseInput[],
  options: { brand?: string | undefined; city?: string | undefined } = {},
): TitleH1Texts {
  const ranked = preparePhrases(phrases).sort(compareRank);
  const main = ranked[0];
  if (main === undefined) {
    throw invalid("phrases", "нет ни одной фразы со словами.", "no phrase has words.");
  }
  const brand = options.brand?.trim() ?? "";
  const city = options.city?.trim() ?? "";
  const cityStems = stemsOf(city);
  const refinements = refinementsOf(
    main,
    ranked,
    city === "" ? cityStems : new Set([...cityStems, ...GEO_WORDS]),
    2,
  );

  const head = capitalize(main.text);
  const hasCity = city !== "" && [...cityStems].every((item) => main.stems.includes(item));
  const cityPart = city !== "" && !hasCity ? `, ${city}` : "";
  const brandPart = brand === "" ? "" : ` | ${brand}`;
  const titleVariants: string[] = [];
  for (let count = refinements.length; count >= 0; count -= 1) {
    const list = refinements.slice(0, count).map((item) => item.text);
    const base = list.length > 0 ? `${head} — ${list.join(", ")}` : head;
    titleVariants.push(`${base}${cityPart}${brandPart}`, `${base}${cityPart}`);
  }
  titleVariants.push(head);
  const title = shorten(titleVariants, TITLE_MAX);

  const mainKey = main.stems.join(" ");
  const second = ranked.slice(1).find((phrase) => phrase.stems.join(" ") !== mainKey);
  const h1 = capitalize(second?.text ?? main.text);

  const cta = brand === "" ? "Узнайте подробнее на сайте!" : `Узнайте подробнее в ${brand}!`;
  const lead = `${head}${cityPart}`;
  const variants = [];
  for (let count = refinements.length; count >= 0; count -= 1) {
    const list = refinements.slice(0, count).map((item) => item.text);
    variants.push(list.length > 0 ? `${lead}: ${list.join(", ")}. ${cta}` : `${lead}. ${cta}`);
  }
  variants.push(`${head}. ${cta}`, head);
  const description = shorten(variants, DESCRIPTION_MAX);

  const listed = refinements.map(describeRefinement).join(", ");
  return {
    title,
    h1,
    description,
    rationale: {
      title:
        refinements.length > 0
          ? `Главная фраза ${quote(main)} + уточнения без изменения формы: ${listed}`
          : `Главная фраза ${quote(main)}`,
      h1: second
        ? `Вторая по частоте формулировка ${quote(second)}`
        : `Других формулировок нет, взята главная фраза ${quote(main)}`,
      description:
        refinements.length > 0
          ? `Главная фраза + те же уточнения: ${refinements.map((item) => item.text).join(", ")}`
          : "Главная фраза и призыв: уточнений нет",
    },
  };
}

function titleTable(texts: TitleH1Texts) {
  return table(
    [
      str("element", "Элемент"),
      str("text", "Текст"),
      num("length", "Символов"),
      str("basis", "Обоснование"),
    ],
    (["title", "h1", "description"] as const).map((element) => ({
      element: element === "h1" ? "H1" : capitalize(element),
      text: texts[element],
      length: [...texts[element]].length,
      basis: texts.rationale[element],
    })),
  );
}

/** True when the call never reaches the API: every phrase comes with its frequency. */
export function titleH1IsLocal(params: TitleH1Params): boolean {
  return params.phrases
    .map(toPhraseItem)
    .every((item) => item.phrase.trim() === "" || item.frequency !== undefined);
}

export async function titleH1(
  session: MutagenSession,
  params: TitleH1Params,
  options: ScenarioOptions = {},
): Promise<ScenarioResult<TitleH1Summary>> {
  const items = phraseItems(params.phrases, MAX_TITLE_PHRASES);
  const region = regionId(params.region ?? DEFAULT_WORDSTAT_REGION);
  const missing = [
    ...new Set(items.filter((item) => item.frequency === undefined).map((item) => item.phrase)),
  ];
  const estimate =
    missing.length > 0
      ? (
          await session.frequency(missing, ["wordstat_qs"], region, {
            ...nested(options),
            dryRun: true,
          })
        ).estimate
      : session.estimate([]);
  if (params.budgetRub !== undefined && estimate.totalRub > params.budgetRub) {
    throw overBudget(estimate, Math.round(params.budgetRub * 100), "частоты фраз кластера");
  }
  const settings = {
    phrases: items.map((item) => [item.phrase, item.frequency ?? null]),
    brand: params.brand,
    city: params.city,
    region,
  };
  return runScenario(
    session,
    {
      label: "title_h1",
      params: settings,
      estimate,
      summary: { phrases: items.length, missingFrequencies: missing.length, region },
      warnings: [],
    },
    options,
    async () => {
      const notes: string[] = [];
      let partial = false;
      let processing = false;
      let found = new Map<string, number>();
      if (missing.length > 0) {
        try {
          const result = await frequencies(session, missing, ["wordstat_qs"], region, options);
          notes.push(...result.warnings);
          found = new Map([...result.values].map(([key, value]) => [key, value.wordstat_qs ?? 0]));
        } catch (error) {
          if (!isStop(error)) throw error;
          notes.push(stopWarning("частоты фраз", error));
          partial = true;
          processing = isTaskPending(error);
        }
      }
      const withFrequency: PhraseItem[] = items.map((item) => ({
        phrase: item.phrase,
        frequency: item.frequency ?? found.get(frequencyKey(item.phrase)) ?? 0,
      }));
      const texts = composeTitleH1(withFrequency, params);
      const main = preparePhrases(withFrequency).sort(compareRank)[0] as PreparedPhrase;
      return {
        table: titleTable(texts),
        summary: {
          ...texts,
          mainPhrase: main.item.phrase,
          mainFrequency: main.frequency,
          frequenciesFrom: missing.length > 0 ? "wordstat_qs" : "input",
        },
        warnings: notes,
        partial,
        processing,
      };
    },
  );
}
