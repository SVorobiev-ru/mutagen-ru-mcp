import { describe, expect, it } from "vitest";
import { buildDictionary } from "../../../src/text/dictionary.js";
import { CEILINGS_AND_WINDOWS } from "./fixtures.js";

describe("buildDictionary", () => {
  it("groups word forms by stem with counts and examples", () => {
    const dictionary = buildDictionary(CEILINGS_AND_WINDOWS);
    expect(dictionary[0]).toEqual({
      stem: "натяжн",
      word: "натяжные",
      forms: ["натяжные", "натяжной", "натяжного", "натяжных"],
      phrases: 23,
      frequency: 275_200,
      examples: ["натяжные потолки", "натяжные потолки цена", "натяжные потолки фото"],
    });
    const windows = dictionary.find((entry) => entry.stem === "окн");
    expect(windows).toMatchObject({ word: "окна", forms: ["окна", "окно"], phrases: 16 });
  });

  it("skips stop words unless asked", () => {
    const phrases = ["окна в москве", "двери в спб"];
    expect(buildDictionary(phrases).some((entry) => entry.stem === "в")).toBe(false);
    expect(buildDictionary(phrases, { includeStopwords: true })[0]).toMatchObject({
      stem: "в",
      phrases: 2,
    });
  });

  it("counts a phrase once per stem and limits examples", () => {
    const dictionary = buildDictionary(["окна окно", "окна пвх", "окна дерево"], { examples: 1 });
    expect(dictionary[0]).toEqual({
      stem: "окн",
      word: "окна",
      forms: ["окна", "окно"],
      phrases: 3,
      frequency: 0,
      examples: ["окна пвх"],
    });
    expect(buildDictionary(["окна"], { examples: 0 })[0]?.examples).toEqual([]);
  });

  it("validates the examples limit", () => {
    expect(() => buildDictionary(["окна"], { examples: -1 })).toThrow(/examples/);
    expect(() => buildDictionary(["окна"], { examples: 1.5 })).toThrow(/examples/);
  });

  it("returns an empty dictionary for empty input", () => {
    expect(buildDictionary([])).toEqual([]);
    expect(buildDictionary(["", "!!!"])).toEqual([]);
  });
});
