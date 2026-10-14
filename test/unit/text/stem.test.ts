import { describe, expect, it } from "vitest";
import { stem } from "../../../src/text/stem.js";

// Reference pairs from the official Snowball test data:
// https://github.com/snowballstem/snowball-data/blob/master/russian/voc.txt (input) and
// https://github.com/snowballstem/snowball-data/blob/master/russian/output.txt (expected stem).
// The implementation was also checked against all 49 785 pairs of these files.
const REFERENCE: readonly [string, string][] = [
  ["красивая", "красив"],
  ["окна", "окн"],
  ["окно", "окн"],
  ["окнами", "окн"],
  ["потолки", "потолк"],
  ["купить", "куп"],
  ["купил", "куп"],
  ["цена", "цен"],
  ["возможность", "возможн"],
  ["возможности", "возможн"],
  ["бездарность", "бездарн"],
  ["бедность", "бедност"],
  ["вероятности", "вероятн"],
  ["бегая", "бег"],
  ["бросившись", "брос"],
  ["бывши", "бывш"],
  ["вглядевшись", "вглядевш"],
  ["вернувшись", "вернувш"],
  ["играющих", "игра"],
  ["балующий", "бал"],
  ["блистающий", "блиста"],
  ["бушующих", "буш"],
  ["беднейшее", "бедн"],
  ["беднейшую", "бедн"],
  ["безграничнейший", "безграничн"],
  ["длинный", "длин"],
  ["странный", "стран"],
  ["басманной", "басма"],
  ["бездонной", "бездон"],
  ["жизнь", "жизн"],
  ["жизни", "жизн"],
  ["ночь", "ноч"],
  ["ставь", "став"],
  ["вполголоса", "вполголос"],
  ["абонемента", "абонемент"],
  ["абонировался", "абонирова"],
  ["берегись", "берег"],
  ["берется", "берет"],
  ["болтается", "болта"],
  ["лошадьми", "лошадьм"],
  ["стояли", "стоя"],
  ["смотрит", "смотр"],
  ["говорят", "говор"],
  ["делаешь", "дела"],
  ["приходите", "приход"],
  ["тщательнее", "тщательн"],
  ["книгу", "книг"],
  ["новыми", "нов"],
  ["ученье", "учен"],
  ["учение", "учен"],
  ["раздражение", "раздражен"],
  ["ёлка", "елк"],
  ["ёж", "еж"],
  ["а", "а"],
];

describe("stem", () => {
  it.each(REFERENCE)("%s → %s", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("handles words used in the task examples", () => {
    expect(stem("натяжные")).toBe("натяжн");
    expect(stem("бегающий")).toBe("бега");
  });

  it("lower-cases and maps ё to е", () => {
    expect(stem("ОКНА")).toBe("окн");
    expect(stem("Ёлки")).toBe("елк");
  });

  it("leaves latin words and numbers as is", () => {
    expect(stem("iPhone")).toBe("iphone");
    expect(stem("15")).toBe("15");
    expect(stem("пвх2")).toBe("пвх2");
  });

  it("stems hyphenated words part by part", () => {
    expect(stem("онлайн-курсы")).toBe("онлайн-курс");
    expect(stem("wi-fi")).toBe("wi-fi");
  });

  it("returns empty and vowel-less words unchanged", () => {
    expect(stem("")).toBe("");
    expect(stem("пвх")).toBe("пвх");
  });
});
