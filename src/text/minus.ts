import { tokenize } from "./normalize.js";
import {
  compareText,
  exampleLimit,
  formsByCount,
  type PhraseInput,
  type PreparedPhrase,
  phraseStems,
  preparePhrases,
  pushTop,
} from "./phrases.js";
import { stem } from "./stem.js";

export type MinusCategory =
  | "free"
  | "download"
  | "diy"
  | "study"
  | "job"
  | "used"
  | "media"
  | "info"
  | "reviews"
  | "entertainment";

export interface MinusCategoryInfo {
  titleRu: string;
  titleEn: string;
  disputed: boolean;
}

export const MINUS_CATEGORIES: Readonly<Record<MinusCategory, MinusCategoryInfo>> = Object.freeze({
  free: { titleRu: "Бесплатно", titleEn: "Free", disputed: false },
  download: { titleRu: "Скачивание", titleEn: "Downloads", disputed: false },
  diy: { titleRu: "Своими руками", titleEn: "Do it yourself", disputed: false },
  study: { titleRu: "Учеба", titleEn: "Study", disputed: false },
  job: { titleRu: "Работа и вакансии", titleEn: "Jobs", disputed: false },
  used: { titleRu: "Б/у и барахолки", titleEn: "Used goods", disputed: false },
  media: { titleRu: "Фото и видео", titleEn: "Photos and videos", disputed: false },
  info: { titleRu: "Справка и определения", titleEn: "Reference", disputed: false },
  reviews: {
    titleRu: "Отзывы и обсуждения (спорно)",
    titleEn: "Reviews (disputed)",
    disputed: true,
  },
  entertainment: { titleRu: "Развлечения", titleEn: "Entertainment", disputed: false },
});

export interface MinusMarker {
  word: string;
  category: MinusCategory;
  disputed?: boolean;
}

function markers(category: MinusCategory, words: string, disputed = ""): MinusMarker[] {
  const doubtful = new Set(disputed.split(",").filter(Boolean));
  return [...words.split(","), ...doubtful].map((word) => ({
    word,
    category,
    ...(doubtful.has(word) ? { disputed: true } : {}),
  }));
}

export const MINUS_MARKERS: readonly MinusMarker[] = Object.freeze([
  ...markers("free", "бесплатно,бесплатный,даром,халява,халявный,безвозмездно,free"),
  ...markers(
    "download",
    "скачать,скачивание,торрент,torrent,download,кряк,крякнутый,взлом,взломанный,apk,mp3,djvu,fb2,epub",
    "pdf",
  ),
  ...markers(
    "diy",
    "своими руками,сделать самому,самостоятельно,как сделать,в домашних условиях,самодельный",
    "чертеж,схема",
  ),
  ...markers(
    "study",
    "реферат,курсовая,курсовой,доклад,диплом,дипломная,презентация,сочинение,гдз,решебник,контрольная,конспект,лекция,егэ,огэ,шпаргалка",
  ),
  ...markers(
    "job",
    "вакансия,вакансии,зарплата,зп,резюме,подработка,трудоустройство,требуется,стажировка,hh",
    "работа",
  ),
  ...markers("used", "б/у,авито,avito,юла,барахолка,подержанный,бывший в употреблении,секонд"),
  ...markers(
    "media",
    "фото,фотографии,фотки,картинки,изображение,видео,смотреть,ролик,youtube,ютуб,рисунок,иллюстрация,png,jpg",
  ),
  ...markers(
    "info",
    "википедия,вики,wiki,wikipedia,что такое,это,определение,значение,толкование,синоним",
    "история,перевод",
  ),
  ...markers("reviews", "отзывы,отзыв,форум,обзор,рейтинг"),
  ...markers(
    "entertainment",
    "игра,мультик,мультфильм,фильм,сериал,песня,аниме,мем,анекдот,стих,раскраска,прикол,майнкрафт,minecraft",
  ),
]);

export interface MinusCandidate {
  word: string;
  marker: string;
  stems: string[];
  category: MinusCategory;
  categoryTitle: string;
  disputed: boolean;
  phrases: number;
  frequency: number;
  examples: string[];
}

export interface MinusOptions {
  targetWords?: readonly string[];
  categories?: readonly MinusCategory[];
  examples?: number;
}

interface CompiledMarker {
  marker: MinusMarker;
  stems: string[];
}

function compileMarkers(): CompiledMarker[] {
  const byKey = new Map<string, CompiledMarker>();
  for (const marker of MINUS_MARKERS) {
    const stems = phraseStems(tokenize(marker.word));
    const key = stems.join(" ");
    if (!byKey.has(key)) byKey.set(key, { marker, stems });
  }
  return [...byKey.values()];
}

let compiled: CompiledMarker[] | undefined;

interface Match {
  compiled: CompiledMarker;
  forms: Map<string, number>;
  phrases: number;
  frequency: number;
  top: PreparedPhrase[];
}

/**
 * Finds built-in off-target markers (free, downloads, jobs, ...) among the phrases by stems.
 * Markers sharing a stem with any of `targetWords` are never suggested.
 */
export function findMinusCandidates(
  phrases: readonly PhraseInput[],
  options: MinusOptions = {},
): MinusCandidate[] {
  const limit = exampleLimit(options.examples);
  const target = new Set(
    (options.targetWords ?? []).flatMap((word) => tokenize(word).map((token) => stem(token))),
  );
  const categories = options.categories === undefined ? undefined : new Set(options.categories);
  compiled ??= compileMarkers();
  const active = compiled.filter(
    ({ marker, stems }) =>
      (categories === undefined || categories.has(marker.category)) &&
      !stems.some((item) => target.has(item)),
  );

  const matches = new Map<CompiledMarker, Match>();
  for (const phrase of preparePhrases(phrases)) {
    const stemmed = phrase.words.map((word) => stem(word));
    const present = new Set(stemmed);
    for (const marker of active) {
      if (!marker.stems.every((item) => present.has(item))) continue;
      let match = matches.get(marker);
      if (match === undefined) {
        match = { compiled: marker, forms: new Map(), phrases: 0, frequency: 0, top: [] };
        matches.set(marker, match);
      }
      if (marker.stems.length === 1) {
        for (const [index, item] of stemmed.entries()) {
          const form = phrase.words[index] as string;
          if (item === marker.stems[0]) match.forms.set(form, (match.forms.get(form) ?? 0) + 1);
        }
      }
      match.phrases += 1;
      match.frequency += phrase.frequency;
      pushTop(match.top, phrase, limit);
    }
  }

  return [...matches.values()]
    .map((match) => {
      const { marker, stems } = match.compiled;
      const info = MINUS_CATEGORIES[marker.category];
      const word = formsByCount(match.forms)[0] ?? tokenize(marker.word).join(" ");
      return {
        word,
        marker: marker.word,
        stems,
        category: marker.category,
        categoryTitle: info.titleRu,
        disputed: info.disputed || marker.disputed === true,
        phrases: match.phrases,
        frequency: match.frequency,
        examples: match.top.map((phrase) => phrase.item.phrase),
      };
    })
    .sort(
      (a, b) => b.phrases - a.phrases || b.frequency - a.frequency || compareText(a.word, b.word),
    );
}
