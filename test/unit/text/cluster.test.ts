import { describe, expect, it } from "vitest";
import {
  type Cluster,
  clusterBySerp,
  clusterLexical,
  normalizeUrl,
} from "../../../src/text/cluster.js";
import type { PhraseItem } from "../../../src/text/phrases.js";
import { CEILINGS_AND_WINDOWS } from "./fixtures.js";

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

function summary(clusters: readonly Cluster[]): [string, string[]][] {
  return clusters.map((cluster) => [
    cluster.name,
    cluster.phrases.slice(1).map((phrase) => phrase.phrase),
  ]);
}

describe("clusterLexical", () => {
  it("groups phrases containing all stems of the main phrase in strict mode", () => {
    const clusters = clusterLexical(CEILINGS_AND_WINDOWS);
    expect(clusters.map((cluster) => cluster.name)).toEqual([
      "натяжные потолки",
      "пластиковые окна",
      "окна пвх",
    ]);
    const [ceilings, windows, pvc] = clusters;
    expect(ceilings?.phrases).toHaveLength(23);
    expect(ceilings?.phrases.map((phrase) => phrase.phrase)).toContain("цена натяжного потолка");
    expect(ceilings?.phrases.map((phrase) => phrase.phrase)).toContain("матовый натяжной потолок");
    expect(ceilings?.frequency).toBe(275_200);
    expect(windows?.phrases).toHaveLength(16);
    expect(windows?.phrases.map((phrase) => phrase.phrase)).toContain(
      "откосы на пластиковые окна своими руками",
    );
    expect(windows?.phrases.map((phrase) => phrase.phrase)).toContain("ремонт пластиковых окон");
    expect(summary([pvc as Cluster])).toEqual([["окна пвх", ["окна пвх цена", "окна пвх купить"]]]);
    expect(clusters.reduce((total, cluster) => total + cluster.phrases.length, 0)).toBe(
      CEILINGS_AND_WINDOWS.length,
    );
  });

  it("groups similar phrases by Jaccard similarity in soft mode", () => {
    const clusters = clusterLexical(CEILINGS_AND_WINDOWS, { mode: "soft" });
    const byName = new Map(summary(clusters));
    expect(byName.get("натяжные потолки")).toContain("матовый натяжной потолок");
    expect(byName.get("натяжные потолки")).toContain("как мыть натяжной потолок");
    expect(byName.get("пластиковые окна")).toContain("ремонт пластиковых окон");
    expect(byName.get("пластиковые окна")).toContain("регулировка пластиковых окон");
    expect(byName.get("установка пластикового окна своими руками")).toEqual([
      "откосы на пластиковые окна своими руками",
    ]);
    expect(byName.get("натяжные потолки")).not.toContain(
      "установка натяжного потолка своими руками",
    );
    expect(byName.get("пластиковые окна")).toContain("цены на пластиковые окна");
    expect(byName.get("пластиковые окна")).not.toContain(
      "как отрегулировать пластиковое окно на зиму",
    );
    expect([...byName.keys()]).toEqual([
      "натяжные потолки",
      "пластиковые окна",
      "окна пвх",
      "как отрегулировать пластиковое окно на зиму",
      "установка натяжного потолка своими руками",
      "установка пластикового окна своими руками",
    ]);
  });

  it("uses the shortest phrase as the main one without frequencies", () => {
    const clusters = clusterLexical([
      "купить окна пвх недорого",
      "окна пвх",
      "окна пвх купить",
      "двери",
    ]);
    expect(summary(clusters)).toEqual([
      ["окна пвх", ["окна пвх купить", "купить окна пвх недорого"]],
      ["двери", []],
    ]);
    expect(clusters[0]?.main).toEqual({ phrase: "окна пвх" });
    expect(clusters[0]?.frequency).toBe(0);
  });

  it("respects the soft threshold", () => {
    const phrases = ["окна пвх", "окна пвх купить", "окна пвх купить москва недорого"];
    expect(clusterLexical(phrases, { mode: "soft", threshold: 1 })).toHaveLength(3);
    expect(clusterLexical(phrases, { mode: "soft", threshold: 0.4 })).toHaveLength(1);
    expect(clusterLexical(phrases, { mode: "soft", threshold: 0.6 })).toHaveLength(2);
  });

  it("validates the threshold", () => {
    expect(() => clusterLexical(["окна"], { mode: "soft", threshold: 0 })).toThrow(/threshold/);
    expect(() => clusterLexical(["окна"], { mode: "soft", threshold: 1.5 })).toThrow(/threshold/);
  });

  it("handles empty input and phrases without words", () => {
    expect(clusterLexical([])).toEqual([]);
    expect(clusterLexical(["", '"!"'])).toEqual([]);
    expect(summary(clusterLexical(["в на", "на в"]))).toEqual([["в на", ["на в"]]]);
  });

  it("is deterministic for shuffled input", () => {
    for (const mode of ["strict", "soft"] as const) {
      const expected = clusterLexical(CEILINGS_AND_WINDOWS, { mode });
      for (const seed of [1, 7, 42]) {
        expect(clusterLexical(shuffle(CEILINGS_AND_WINDOWS, seed), { mode })).toEqual(expected);
      }
    }
  });

  it("clusters 50 000 phrases in under 5 seconds", { timeout: 20_000 }, () => {
    const syllables = ["ка", "ло", "ми", "ре", "ту", "со", "ны", "ва", "пе", "ди", "ро", "жу"];
    const word = (n: number) =>
      `${syllables[n % 12]}${syllables[Math.floor(n / 12) % 12]}${syllables[Math.floor(n / 144) % 12]}ный`;
    const common = ["купить", "цена", "москва", "недорого", "отзывы"];
    const phrases: PhraseItem[] = [];
    let state = 17;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state;
    };
    for (let index = 0; index < 50_000; index += 1) {
      const words = [word(next() % 1_500), word(next() % 1_500)];
      if (next() % 3 === 0) words.push(common[next() % common.length] as string);
      if (next() % 2 === 0) words.push(word(next() % 1_500));
      phrases.push({ phrase: words.join(" "), frequency: next() % 10_000 });
    }
    for (const mode of ["strict", "soft"] as const) {
      const started = performance.now();
      const clusters = clusterLexical(phrases, { mode });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(clusters.reduce((total, cluster) => total + cluster.phrases.length, 0)).toBe(50_000);
    }
  });
});

describe("normalizeUrl", () => {
  it("drops scheme, www, fragment and trailing slash", () => {
    expect(normalizeUrl(" https://www.Example.COM/Path/?a=1#top ")).toBe("example.com/Path/?a=1");
    expect(normalizeUrl("http://example.com/")).toBe("example.com");
    expect(normalizeUrl("example.com/page/")).toBe("example.com/page");
  });
});

describe("clusterBySerp", () => {
  const top = (...ids: number[]) => ids.map((id) => `https://site${id}.ru/`);
  const serps = new Map<string, string[]>([
    ["натяжные потолки", top(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)],
    ["натяжной потолок", top(1, 2, 3, 4, 5, 11, 12, 13, 14, 15)],
    ["потолки натяжные цена", top(1, 2, 3, 16, 17, 18, 19, 20, 21, 22)],
    ["натяжные потолки установка", top(6, 7, 8, 30, 31, 32, 33, 34, 35, 36)],
    ["пластиковые окна", top(40, 41, 42, 43, 44, 45, 46, 47, 48, 49)],
    ["окна пвх", top(40, 41, 42, 50, 51, 52, 53, 54, 55, 56)],
  ]);
  const phrases: PhraseItem[] = [
    { phrase: "натяжные потолки", frequency: 100 },
    { phrase: "натяжной потолок", frequency: 50 },
    { phrase: "потолки натяжные цена", frequency: 40 },
    { phrase: "натяжные потолки установка", frequency: 30 },
    { phrase: "пластиковые окна", frequency: 90 },
    { phrase: "Окна ПВХ", frequency: 80 },
    { phrase: "без выдачи", frequency: 1 },
  ];

  it("joins phrases sharing enough URLs with the main phrase in soft mode", () => {
    expect(summary(clusterBySerp(phrases, serps))).toEqual([
      [
        "натяжные потолки",
        ["натяжной потолок", "потолки натяжные цена", "натяжные потолки установка"],
      ],
      ["пластиковые окна", ["Окна ПВХ"]],
      ["без выдачи", []],
    ]);
  });

  it("requires shared URLs with every member in hard mode", () => {
    expect(summary(clusterBySerp(phrases, serps, { mode: "hard" }))).toEqual([
      ["натяжные потолки", ["натяжной потолок", "потолки натяжные цена"]],
      ["пластиковые окна", ["Окна ПВХ"]],
      ["натяжные потолки установка", []],
      ["без выдачи", []],
    ]);
  });

  it("respects minCommon and depth", () => {
    expect(clusterBySerp(phrases, serps, { minCommon: 4 })).toHaveLength(6);
    expect(clusterBySerp(phrases, serps, { depth: 2 })).toHaveLength(7);
    expect(clusterBySerp(phrases, serps, { depth: 2, minCommon: 2 })).toHaveLength(4);
  });

  it("prefers candidates with closer positions in hard mode", () => {
    const urls = new Map<string, string[]>([
      ["a", top(1, 2, 3, 4)],
      ["b", top(7, 8, 9, 3, 4)],
      ["c", top(1, 2, 10, 11)],
    ]);
    const clusters = clusterBySerp(["a", "b", "c"], urls, { mode: "hard", minCommon: 2 });
    expect(summary(clusters)).toEqual([
      ["a", ["c"]],
      ["b", []],
    ]);
  });

  it("validates options", () => {
    expect(() => clusterBySerp(phrases, serps, { minCommon: 0 })).toThrow(/minCommon/);
    expect(() => clusterBySerp(phrases, serps, { depth: 1.5 })).toThrow(/depth/);
  });

  it("is deterministic for shuffled input", () => {
    const expected = clusterBySerp(phrases, serps, { mode: "hard" });
    for (const seed of [3, 11]) {
      expect(clusterBySerp(shuffle(phrases, seed), serps, { mode: "hard" })).toEqual(expected);
    }
  });
});
