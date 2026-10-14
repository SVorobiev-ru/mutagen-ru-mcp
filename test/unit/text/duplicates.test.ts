import { describe, expect, it } from "vitest";
import { groupDuplicates, removeDuplicates } from "../../../src/text/duplicates.js";
import { compareStems, phraseKey, phraseStems, toPhraseItem } from "../../../src/text/phrases.js";
import { CEILINGS_AND_WINDOWS } from "./fixtures.js";

describe("phraseKey", () => {
  it("ignores word order, word forms and stop words", () => {
    expect(phraseKey("цены на пластиковые окна")).toBe("окн пластикв цен");
    expect(phraseKey("Пластиковое окно цена")).toBe("окн пластикв цен");
  });

  it("drops a fleeting vowel only in the comparison key", () => {
    expect(phraseKey("ремонт пластиковых окон")).toBe(phraseKey("пластиковые окна ремонт"));
    expect(phraseKey("натяжной потолок")).toBe(phraseKey("натяжные потолки"));
    expect(phraseKey("замок")).toBe(phraseKey("замки"));
    expect(phraseStems(["потолок"])).toEqual(["потолок"]);
    expect(compareStems(["потолок", "окон"])).toEqual(["окн", "потолк"]);
  });

  it("keeps stop words when the phrase has nothing else", () => {
    expect(phraseKey("в на")).toBe("в на");
    expect(phraseStems([])).toEqual([]);
  });

  it("deduplicates repeated stems", () => {
    expect(phraseKey("окна окно")).toBe("окн");
  });
});

describe("toPhraseItem", () => {
  it("rejects bad input", () => {
    expect(() => toPhraseItem({ phrase: 5 } as never)).toThrow(/phrase/);
    expect(() => toPhraseItem(null as never)).toThrow(/phrase/);
    expect(() => toPhraseItem({ phrase: "окна", frequency: -1 })).toThrow(/frequency/);
    expect(() => toPhraseItem({ phrase: "окна", frequency: Number.NaN })).toThrow(/frequency/);
  });
});

describe("groupDuplicates", () => {
  it("finds implicit duplicates and picks the most frequent representative", () => {
    const groups = groupDuplicates(CEILINGS_AND_WINDOWS);
    expect(groups).toEqual([
      {
        key: "натяжн потолк цен",
        representative: { phrase: "натяжные потолки цена", frequency: 45_000 },
        phrases: [
          { phrase: "натяжные потолки цена", frequency: 45_000 },
          { phrase: "цена натяжного потолка", frequency: 9_000 },
        ],
        frequency: 54_000,
      },
      {
        key: "окн пластикв цен",
        representative: { phrase: "пластиковые окна цена", frequency: 25_000 },
        phrases: [
          { phrase: "пластиковые окна цена", frequency: 25_000 },
          { phrase: "цены на пластиковые окна", frequency: 6_000 },
        ],
        frequency: 31_000,
      },
    ]);
  });

  it("picks the shortest phrase without frequencies", () => {
    const [group] = groupDuplicates([
      "купить окна пвх в москве",
      "окна пвх купить",
      "окно пвх купить",
    ]);
    expect(group?.representative).toEqual({ phrase: "окна пвх купить" });
    expect(group?.frequency).toBe(0);
  });

  it("finds explicit duplicates only after normalization", () => {
    const groups = groupDuplicates(["Окна  ПВХ", '"окна пвх"', "пвх окна", "!окна !пвх -дерево"], {
      mode: "explicit",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("окна пвх");
    expect(groups[0]?.phrases).toHaveLength(3);
  });

  it("can include unique phrases and skips empty ones", () => {
    const groups = groupDuplicates(["окна", "", "!!!", "двери"], { includeUnique: true });
    expect(groups.map((group) => group.key)).toEqual(["двр", "окн"]);
  });

  it("does not depend on the input order", () => {
    const shuffled = [...CEILINGS_AND_WINDOWS].reverse();
    expect(groupDuplicates(shuffled)).toEqual(groupDuplicates(CEILINGS_AND_WINDOWS));
  });
});

describe("removeDuplicates", () => {
  it("keeps one representative per group in input order", () => {
    expect(
      removeDuplicates([
        "цены на окна",
        { phrase: "окна цена", frequency: 10 },
        "двери",
        "окна цена",
        "",
      ]),
    ).toEqual([{ phrase: "окна цена", frequency: 10 }, { phrase: "двери" }]);
  });

  it("supports explicit mode", () => {
    expect(removeDuplicates(["окна цена", "цена окна", "Окна цена"], { mode: "explicit" })).toEqual(
      [{ phrase: "Окна цена" }, { phrase: "цена окна" }],
    );
  });
});
