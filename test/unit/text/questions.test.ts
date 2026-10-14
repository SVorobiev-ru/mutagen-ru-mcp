import { describe, expect, it } from "vitest";
import { detectQuestion, findQuestions, isQuestion } from "../../../src/text/questions.js";

describe("detectQuestion", () => {
  it.each([
    ["как мыть натяжной потолок", "how", "как"],
    ["что такое натяжной потолок", "what", "что"],
    ["чем мыть окна", "what", "чем"],
    ["почему потеют окна", "why", "почему"],
    ["зачем нужен подоконник", "purpose", "зачем"],
    ["где купить окна", "where", "где"],
    ["куда сдать окна", "where_to", "куда"],
    ["откуда дует окно", "where_from", "откуда"],
    ["когда менять окна", "when", "когда"],
    ["какие окна лучше", "which", "какие"],
    ["Какой потолок выбрать", "which", "какой"],
    ["сколько стоит натяжной потолок", "how_much", "сколько"],
    ["кто делает натяжные потолки", "who", "кто"],
    ["можно ли мыть потолок", "can", "можно ли"],
    ["нужно ли грунтовать стены", "need", "нужно ли"],
    ["стоит ли ставить натяжной потолок", "worth", "стоит ли"],
    ["выгодно ли менять окна", "yes_no", "ли"],
    ["окна пвх как выбрать", "how", "как"],
  ])("%s → %s", (phrase, type, marker) => {
    expect(detectQuestion(phrase)).toEqual({ isQuestion: true, type, marker });
  });

  it("prefers modal questions over question words", () => {
    expect(detectQuestion("как можно ли")).toMatchObject({ type: "can" });
  });

  it("returns false for non-questions", () => {
    expect(detectQuestion("купить окна пвх")).toEqual({ isQuestion: false });
    expect(detectQuestion("сколько-нибудь")).toEqual({ isQuestion: false });
    expect(isQuestion("")).toBe(false);
    expect(isQuestion("как")).toBe(true);
  });
});

describe("findQuestions", () => {
  it("keeps only questions with their type", () => {
    expect(
      findQuestions(["окна пвх", { phrase: "как выбрать окно", frequency: 10 }, "где окна"]),
    ).toEqual([
      { phrase: "как выбрать окно", frequency: 10, type: "how", marker: "как" },
      { phrase: "где окна", type: "where", marker: "где" },
    ]);
  });
});
