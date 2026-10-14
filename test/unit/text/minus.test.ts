import { describe, expect, it } from "vitest";
import { findMinusCandidates, MINUS_CATEGORIES, MINUS_MARKERS } from "../../../src/text/minus.js";
import { phraseKey } from "../../../src/text/phrases.js";
import { CEILINGS_AND_WINDOWS } from "./fixtures.js";

describe("minus markers", () => {
  it("has about 80 distinct stems across all categories", () => {
    const keys = new Set(MINUS_MARKERS.map((marker) => phraseKey(marker.word)));
    expect(keys.size).toBeGreaterThanOrEqual(80);
    const categories = new Set(MINUS_MARKERS.map((marker) => marker.category));
    expect([...categories].sort()).toEqual(Object.keys(MINUS_CATEGORIES).sort());
  });

  it("marks reviews as disputed", () => {
    expect(MINUS_CATEGORIES.reviews.disputed).toBe(true);
    expect(MINUS_CATEGORIES.free.disputed).toBe(false);
  });
});

describe("findMinusCandidates", () => {
  it("finds off-target words in a semantic core", () => {
    const candidates = findMinusCandidates(CEILINGS_AND_WINDOWS);
    expect(candidates.map((candidate) => [candidate.word, candidate.category])).toEqual([
      ["своими руками", "diy"],
      ["фото", "media"],
      ["вакансии", "job"],
      ["отзывы", "reviews"],
      ["авито", "used"],
      ["бу", "used"],
    ]);
    expect(candidates[1]).toEqual({
      word: "фото",
      marker: "фото",
      stems: ["фот"],
      category: "media",
      categoryTitle: "Фото и видео",
      disputed: false,
      phrases: 3,
      frequency: 23_900,
      examples: [
        "натяжные потолки фото",
        "натяжной потолок фото в зале",
        "натяжные потолки матовые фото",
      ],
    });
    expect(candidates[3]?.disputed).toBe(true);
  });

  it("matches word forms and multi-word markers", () => {
    const candidates = findMinusCandidates([
      "скачать бесплатно шрифты",
      "шрифты бесплатные",
      "что такое шрифт",
      "такое бывает",
      "работа шрифтовиком",
    ]);
    expect(candidates.find((candidate) => candidate.category === "free")).toMatchObject({
      word: "бесплатно",
      phrases: 2,
    });
    expect(candidates.find((candidate) => candidate.marker === "что такое")).toMatchObject({
      word: "что такое",
      phrases: 1,
      examples: ["что такое шрифт"],
    });
    expect(candidates.find((candidate) => candidate.marker === "работа")).toMatchObject({
      disputed: true,
    });
  });

  it("never suggests target words", () => {
    const phrases = ["фото на документы", "фотопечать", "фото студия цена"];
    expect(findMinusCandidates(phrases).map((candidate) => candidate.word)).toEqual(["фото"]);
    expect(findMinusCandidates(phrases, { targetWords: ["Фото"] })).toEqual([]);
  });

  it("filters by category and limits examples", () => {
    const candidates = findMinusCandidates(CEILINGS_AND_WINDOWS, {
      categories: ["used"],
      examples: 0,
    });
    expect(candidates.map((candidate) => candidate.word)).toEqual(["авито", "бу"]);
    expect(candidates[0]?.examples).toEqual([]);
  });

  it("returns nothing for clean or empty input", () => {
    expect(findMinusCandidates(["купить окна пвх"])).toEqual([]);
    expect(findMinusCandidates([])).toEqual([]);
  });
});
