import { describe, expect, it } from "vitest";
import { normalizePhrase, normalizeText, tokenize } from "../../../src/text/normalize.js";
import { isStopword, RUSSIAN_STOPWORDS, significantWords } from "../../../src/text/stopwords.js";

describe("tokenize", () => {
  it("splits cyrillic, latin and digits", () => {
    expect(tokenize("Купить iPhone 15 Pro")).toEqual(["купить", "iphone", "15", "pro"]);
  });

  it("keeps hyphenated words and decimal numbers whole", () => {
    expect(tokenize("онлайн-курс по SEO 2,5 часа или 1.5")).toEqual([
      "онлайн-курс",
      "по",
      "seo",
      "2,5",
      "часа",
      "или",
      "1.5",
    ]);
  });

  it("drops punctuation and dangling hyphens", () => {
    expect(tokenize("окна — пвх, недорого!!! -")).toEqual(["окна", "пвх", "недорого"]);
  });

  it("maps ё to е and б/у to бу", () => {
    expect(tokenize("Ёлка б/у")).toEqual(["елка", "бу"]);
  });

  it("returns nothing for empty text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("normalizePhrase", () => {
  it("removes Wordstat operators", () => {
    expect(normalizePhrase('"!купить [пластиковые +на окна]" (москва|спб)')).toEqual({
      source: '"!купить [пластиковые +на окна]" (москва|спб)',
      text: "купить пластиковые на окна москва спб",
      words: ["купить", "пластиковые", "на", "окна", "москва", "спб"],
      minusWords: [],
    });
  });

  it("moves minus words to a separate field", () => {
    const result = normalizePhrase("окна пвх -бесплатно -!своими -скачать -бесплатно");
    expect(result.text).toBe("окна пвх");
    expect(result.minusWords).toEqual(["бесплатно", "своими", "скачать"]);
  });

  it("does not treat a hyphen inside a word as a minus", () => {
    const result = normalizePhrase("онлайн-курс -бесплатно");
    expect(result.words).toEqual(["онлайн-курс"]);
    expect(result.minusWords).toEqual(["бесплатно"]);
  });

  it("returns empty text for operators only", () => {
    expect(normalizePhrase('"[!+]" ( | )')).toMatchObject({ text: "", words: [] });
    expect(normalizePhrase("")).toMatchObject({ text: "", words: [], minusWords: [] });
  });

  it("collapses spaces and case", () => {
    expect(normalizeText("  Натяжные   ПОТОЛКИ  в   Москве ")).toBe("натяжные потолки в москве");
    expect(normalizeText("ЁМКОСТЬ")).toBe("емкость");
  });
});

describe("stopwords", () => {
  it("contains prepositions, conjunctions and particles", () => {
    for (const word of ["в", "на", "для", "из-за", "и", "или", "ли", "же", "бы"]) {
      expect(RUSSIAN_STOPWORDS.has(word)).toBe(true);
    }
  });

  it("keeps question words and negations significant", () => {
    for (const word of ["как", "что", "где", "не", "ни", "надо"])
      expect(isStopword(word)).toBe(false);
  });

  it("filters stop words case-insensitively", () => {
    expect(significantWords(["окна", "В", "москве", "для", "дачи"])).toEqual([
      "окна",
      "москве",
      "дачи",
    ]);
  });
});
