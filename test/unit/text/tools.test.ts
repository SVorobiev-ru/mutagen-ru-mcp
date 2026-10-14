import { describe, expect, it } from "vitest";
import {
  charCount,
  combinator,
  compareLists,
  filterByMask,
  MAX_COMBINATIONS,
  wordCount,
} from "../../../src/text/tools.js";

describe("combinator", () => {
  it("builds the cartesian product in list order", () => {
    expect(combinator([["купить", "заказать"], ["окна", "двери"], ["пвх"]])).toEqual([
      "купить окна пвх",
      "купить двери пвх",
      "заказать окна пвх",
      "заказать двери пвх",
    ]);
  });

  it("treats empty strings as optional slots and drops repeats", () => {
    expect(combinator([["купить", ""], ["  окна  пвх "], ["", "москва"]])).toEqual([
      "купить окна пвх",
      "купить окна пвх москва",
      "окна пвх",
      "окна пвх москва",
    ]);
    expect(combinator([["окна", "окна"], [""]])).toEqual(["окна"]);
    expect(combinator([[""], [""]])).toEqual([]);
  });

  it("returns nothing when a list is empty", () => {
    expect(combinator([])).toEqual([]);
    expect(combinator([["окна"], []])).toEqual([]);
  });

  it("rejects more than 100 000 results", () => {
    const list = Array.from({ length: 1_000 }, (_, index) => `w${index}`);
    expect(combinator([list, list.slice(0, 100)])).toHaveLength(MAX_COMBINATIONS);
    expect(() => combinator([list, list.slice(0, 101)])).toThrow(/limit is 100000/);
  });
});

describe("compareLists", () => {
  it("compares normalized phrases", () => {
    expect(
      compareLists(
        ["Окна ПВХ", "двери", "окна цена", "двери"],
        ['"окна пвх"', "цена окна", "потолки", ""],
      ),
    ).toEqual({
      onlyA: ["двери", "окна цена"],
      onlyB: ["цена окна", "потолки"],
      both: ["Окна ПВХ"],
    });
  });

  it("can compare by implicit duplicates", () => {
    expect(compareLists(["окна цена"], ["цены на окна"], { implicit: true })).toEqual({
      onlyA: [],
      onlyB: [],
      both: ["окна цена"],
    });
  });
});

describe("filterByMask", () => {
  const phrases = [
    "купить пластиковые окна",
    "пластиковое окно цена",
    "окна пвх своими руками",
    "натяжные потолки",
    "iphone 15 pro купить",
  ];

  it("includes phrases containing any include entry by stems", () => {
    expect(filterByMask(phrases, { include: ["окно"] })).toEqual(phrases.slice(0, 3));
    expect(filterByMask(phrases, { include: ["пластиковые окна", "потолок натяжной"] })).toEqual([
      "купить пластиковые окна",
      "пластиковое окно цена",
    ]);
    expect(filterByMask(phrases, { include: ["потолки", "iPhone"] })).toEqual([
      "натяжные потолки",
      "iphone 15 pro купить",
    ]);
  });

  it("excludes phrases with exclude entries", () => {
    expect(
      filterByMask(phrases, { include: ["окна"], exclude: ["своими руками", "купить"] }),
    ).toEqual(["пластиковое окно цена"]);
    expect(filterByMask(phrases, { include: [""], exclude: ["   "] })).toEqual(phrases);
  });

  it("filters by regex and word count", () => {
    expect(filterByMask(phrases, { regex: "^ОКНА" })).toEqual(["окна пвх своими руками"]);
    expect(filterByMask(phrases, { regex: "\\d+" })).toEqual(["iphone 15 pro купить"]);
    expect(filterByMask(phrases, { minWords: 4 })).toEqual([
      "окна пвх своими руками",
      "iphone 15 pro купить",
    ]);
    expect(filterByMask(phrases, { maxWords: 2 })).toEqual(["натяжные потолки"]);
  });

  it("keeps phrase objects", () => {
    const items = [{ phrase: "окна", frequency: 5 }, { phrase: "двери" }];
    expect(filterByMask(items, { include: ["окно"] })).toEqual([{ phrase: "окна", frequency: 5 }]);
  });

  it("rejects an invalid regex", () => {
    expect(() => filterByMask(phrases, { regex: "(" })).toThrow(/regex/i);
  });
});

describe("counters", () => {
  it("counts words of the normalized phrase", () => {
    expect(wordCount("купить iPhone 15 Pro -бу")).toBe(4);
    expect(wordCount("онлайн-курс по SEO")).toBe(3);
    expect(wordCount('"!"')).toBe(0);
  });

  it("counts characters of the raw text", () => {
    expect(charCount("Ёлка 2 м")).toBe(8);
    expect(charCount("Ёлка 2 м", { spaces: false })).toBe(6);
    expect(charCount("окно 🪟")).toBe(6);
    expect(charCount("")).toBe(0);
  });
});
