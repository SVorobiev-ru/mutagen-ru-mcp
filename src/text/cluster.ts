import { validationError } from "../core/errors.js";
import { requirePositive } from "../core/validate.js";
import { normalizeText } from "./normalize.js";
import {
  compareRank,
  compareText,
  type PhraseInput,
  type PhraseItem,
  type PreparedPhrase,
  preparePhrases,
  sumFrequency,
} from "./phrases.js";

export interface Cluster {
  name: string;
  main: PhraseItem;
  phrases: PhraseItem[];
  frequency: number;
}

export type LexicalClusterMode = "strict" | "soft";

export interface LexicalClusterOptions {
  mode?: LexicalClusterMode;
  threshold?: number;
}

export type SerpClusterMode = "soft" | "hard";

export interface SerpClusterOptions {
  mode?: SerpClusterMode;
  minCommon?: number;
  depth?: number;
}

const EPSILON = 1e-9;

function toClusters(items: readonly PreparedPhrase[], groups: readonly number[][]): Cluster[] {
  return groups
    .map((group) => {
      const members = group.map((index) => items[index] as PreparedPhrase);
      const main = (members[0] as PreparedPhrase).item;
      return {
        name: main.phrase,
        main,
        phrases: members.map((member) => member.item),
        frequency: sumFrequency(members),
      };
    })
    .sort(
      (a, b) =>
        b.frequency - a.frequency ||
        b.phrases.length - a.phrases.length ||
        compareText(a.name, b.name),
    );
}

function addPosting(index: Map<string, number[]>, key: string, item: number): void {
  const list = index.get(key);
  if (list) list.push(item);
  else index.set(key, [item]);
}

/** Drops assigned items from the posting list in place and returns the rest. */
function livePostings(index: Map<string, number[]>, key: string, assigned: Uint8Array): number[] {
  const list = index.get(key) ?? [];
  let size = 0;
  for (const item of list) if (assigned[item] === 0) list[size++] = item;
  list.length = size;
  return list;
}

function lexicalThreshold(value: number | undefined): number {
  if (value === undefined) return 0.5;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw validationError(
      `Invalid option threshold: ${String(value)}`,
      `Неверный порог threshold: ${String(value)}. Нужно число больше 0 и не больше 1.`,
      `Invalid option threshold: ${String(value)}. Expected a number above 0 and up to 1.`,
    );
  }
  return value;
}

/**
 * Lexical clustering. The best-ranked unclustered phrase (highest frequency, then shortest)
 * opens a cluster; strict mode adds phrases containing all of its significant stems, soft mode
 * adds phrases whose Jaccard similarity of stems with it reaches the threshold.
 */
export function clusterLexical(
  phrases: readonly PhraseInput[],
  options: LexicalClusterOptions = {},
): Cluster[] {
  const mode = options.mode ?? "strict";
  const threshold = lexicalThreshold(options.threshold);
  const items = preparePhrases(phrases).sort(compareRank);

  const documentFrequency = new Map<string, number>();
  for (const item of items) {
    for (const stem of item.stems) {
      documentFrequency.set(stem, (documentFrequency.get(stem) ?? 0) + 1);
    }
  }
  const byRarity = (a: string, b: string) =>
    (documentFrequency.get(a) ?? 0) - (documentFrequency.get(b) ?? 0) || compareText(a, b);
  const ordered = items.map((item) => [...item.stems].sort(byRarity));
  const sets = items.map((item) => new Set(item.stems));
  const prefixLength = (size: number) =>
    mode === "strict" ? size : size - Math.ceil(threshold * size - EPSILON) + 1;

  const index = new Map<string, number[]>();
  ordered.forEach((stems, item) => {
    for (const stem of stems.slice(0, prefixLength(stems.length))) addPosting(index, stem, item);
  });

  const assigned = new Uint8Array(items.length);
  const seenBy = new Int32Array(items.length).fill(-1);
  const groups: number[][] = [];
  for (let main = 0; main < items.length; main += 1) {
    if (assigned[main] === 1) continue;
    assigned[main] = 1;
    const group = [main];
    const stems = ordered[main] as string[];
    const probes =
      mode === "strict" ? stems.slice(0, 1) : stems.slice(0, prefixLength(stems.length));
    const candidates: number[] = [];
    for (const probe of probes) {
      for (const item of livePostings(index, probe, assigned)) {
        if (seenBy[item] === main) continue;
        seenBy[item] = main;
        candidates.push(item);
      }
    }
    candidates.sort((a, b) => a - b);
    for (const item of candidates) {
      const set = sets[item] as Set<string>;
      let common = 0;
      for (const stem of stems) if (set.has(stem)) common += 1;
      const joins =
        mode === "strict"
          ? common === stems.length
          : common >= threshold * (stems.length + set.size - common) - EPSILON;
      if (joins) {
        assigned[item] = 1;
        group.push(item);
      }
    }
    groups.push(group);
  }
  return toClusters(items, groups);
}

/** Lower-cases the host and drops the scheme, «www.», the fragment and a trailing slash. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/#.*$/, "");
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([^/?]*)(.*)$/i.exec(trimmed);
  const host = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").replace(/\/+$/, "");
  return host + rest;
}

function urlPositions(urls: readonly string[], depth: number): Map<string, number> {
  const positions = new Map<string, number>();
  for (const url of urls.slice(0, depth)) {
    const key = normalizeUrl(url);
    if (key !== "" && !positions.has(key)) positions.set(key, positions.size);
  }
  return positions;
}

function commonUrls(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let common = 0;
  for (const url of a.keys()) if (b.has(url)) common += 1;
  return common;
}

/**
 * Clustering by search results: soft mode joins a phrase to a cluster when it shares at least
 * `minCommon` URLs of the top `depth` with the main phrase, hard mode — with every phrase of the
 * cluster. Closer positions of the shared URLs break ties.
 */
export function clusterBySerp(
  phrases: readonly PhraseInput[],
  urlsByPhrase: ReadonlyMap<string, readonly string[]>,
  options: SerpClusterOptions = {},
): Cluster[] {
  const mode = options.mode ?? "soft";
  const minCommon = requirePositive("minCommon", options.minCommon ?? 3, true);
  const depth = requirePositive("depth", options.depth ?? 10, true);
  const items = preparePhrases(phrases).sort(compareRank);

  const byText = new Map<string, readonly string[]>();
  for (const [phrase, urls] of urlsByPhrase) {
    const key = normalizeText(phrase);
    if (!byText.has(key)) byText.set(key, urls);
  }
  const serps = items.map((item) =>
    urlPositions(urlsByPhrase.get(item.item.phrase) ?? byText.get(item.text) ?? [], depth),
  );

  const index = new Map<string, number[]>();
  serps.forEach((serp, item) => {
    for (const url of serp.keys()) addPosting(index, url, item);
  });

  const assigned = new Uint8Array(items.length);
  const groups: number[][] = [];
  for (let main = 0; main < items.length; main += 1) {
    if (assigned[main] === 1) continue;
    assigned[main] = 1;
    const mainSerp = serps[main] as Map<string, number>;
    const common = new Map<number, { count: number; score: number }>();
    for (const [url, position] of mainSerp) {
      for (const item of livePostings(index, url, assigned)) {
        const itemPosition = (serps[item] as Map<string, number>).get(url) as number;
        const entry = common.get(item) ?? { count: 0, score: 0 };
        entry.count += 1;
        entry.score += 2 * depth - position - itemPosition;
        common.set(item, entry);
      }
    }
    const candidates = [...common]
      .filter(([, entry]) => entry.count >= minCommon)
      .sort(([a, x], [b, y]) => y.count - x.count || y.score - x.score || a - b);
    const group = [main];
    for (const [item] of candidates) {
      const serp = serps[item] as Map<string, number>;
      if (
        mode === "hard" &&
        !group.every(
          (member) => commonUrls(serp, serps[member] as Map<string, number>) >= minCommon,
        )
      ) {
        continue;
      }
      assigned[item] = 1;
      group.push(item);
    }
    group.sort((a, b) => a - b);
    groups.push(group);
  }
  return toClusters(items, groups);
}
