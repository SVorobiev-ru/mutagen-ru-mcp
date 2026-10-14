import { describe, expect, it } from "vitest";
import {
  API_ERRORS,
  apiError,
  apiErrorInfo,
  codeFromApiMessage,
  combineFailures,
  isMutagenError,
  isTaskPending,
  MutagenError,
  TaskPendingError,
} from "../../../src/core/errors.js";

describe("API error table", () => {
  it("covers codes 100–118", () => {
    for (let code = 100; code <= 118; code += 1) expect(apiErrorInfo(code)?.code).toBe(code);
    expect(apiErrorInfo(99)).toBeUndefined();
    expect(apiErrorInfo(119)).toBeUndefined();
  });

  it("marks only 110, 113 and 114 as retryable", () => {
    const retryable = Object.values(API_ERRORS)
      .filter((info) => info.retryable)
      .map((info) => info.code);
    expect(retryable).toEqual([110, 113, 114]);
  });

  it("has Russian and English hints for every code", () => {
    for (const info of Object.values(API_ERRORS)) {
      expect(info.hintRu).toMatch(/[а-яё]/i);
      expect(info.hintEn).toMatch(/[a-z]/i);
    }
  });
});

describe("codeFromApiMessage", () => {
  it.each([
    ["MUTAGEN.RU: Not enough params", 100],
    ["mutagen.ru: low balance", 106],
    ["Low balance", 106],
    ["MUTAGEN.RU: No action...", 104],
    ["MUTAGEN.RU: No action", 104],
    ["MUTAGEN.RU: options error: keys_list", 108],
    ["MUTAGEN.RU: report could not be generated", 118],
  ])("maps %s to %i", (message, code) => {
    expect(codeFromApiMessage(message)).toBe(code);
  });

  it("returns undefined for unknown or empty messages", () => {
    expect(codeFromApiMessage("something else")).toBeUndefined();
    expect(codeFromApiMessage("MUTAGEN.RU: ")).toBeUndefined();
  });
});

describe("apiError", () => {
  it("builds a known error with the documented message when none is given", () => {
    const error = apiError(111, undefined);
    expect(error).toMatchObject({ kind: "subscription_required", code: 111, retryable: false });
    expect(error.message).toBe("Mutagen API error 111: subscription required");
    expect(error.hintRu).toContain("подписка");
  });

  it("builds an unknown error", () => {
    expect(apiError(undefined, undefined).message).toBe("Mutagen API error: Unknown API error");
    expect(apiError(150, "x")).toMatchObject({ kind: "api", code: 150 });
  });
});

describe("MutagenError", () => {
  it("serializes without the cause and recognizes itself", () => {
    const error = new MutagenError({
      kind: "network",
      message: "boom",
      retryable: true,
      hintRu: "ру",
      hintEn: "en",
      cause: new Error("inner"),
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MutagenError");
    expect(isMutagenError(error)).toBe(true);
    expect(isMutagenError(new Error("x"))).toBe(false);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "MutagenError",
      kind: "network",
      retryable: true,
      message: "boom",
      hintRu: "ру",
      hintEn: "en",
    });
    expect(new MutagenError({ kind: "api", message: "m", hintRu: "", hintEn: "" }).retryable).toBe(
      false,
    );
  });
});

describe("TaskPendingError", () => {
  it("tells to repeat the call for free and lists the tasks", () => {
    const error = new TaskPendingError(["check_key 1", "parser.mass 2"]);
    expect(error).toBeInstanceOf(MutagenError);
    expect(error).toMatchObject({ kind: "task_pending", retryable: true });
    expect(error.hintRu).toContain("Повторите тот же вызов позже — повтор бесплатный");
    expect(error.hintRu).toContain("check_key 1, parser.mass 2");
    expect(error.toJSON()).toMatchObject({ tasks: ["check_key 1", "parser.mass 2"] });
    expect(isTaskPending(error)).toBe(true);
    expect(isTaskPending(new Error("x"))).toBe(false);
  });

  it("combines parallel failures: a real error wins, else all pending tasks", () => {
    const real = new Error("boom");
    expect(combineFailures([new TaskPendingError(["a"]), real])).toBe(real);
    const merged = combineFailures([new TaskPendingError(["a"]), new TaskPendingError(["b"])]);
    expect(merged).toMatchObject({ kind: "task_pending", tasks: ["a", "b"] });
  });

  it("apiError keeps error_detail in the message, the hint and detail", () => {
    const error = apiError(107, "MUTAGEN.RU: task_id not found", " Нет проекта с таким id ");
    expect(error).toMatchObject({ kind: "not_found", code: 107, detail: "Нет проекта с таким id" });
    expect(error.message).toBe(
      "Mutagen API error 107: MUTAGEN.RU: task_id not found — Нет проекта с таким id",
    );
    expect(error.hintRu.startsWith("Мутаген: «Нет проекта с таким id».")).toBe(true);
    expect(error.toJSON()).toMatchObject({ detail: "Нет проекта с таким id" });
    expect(apiError(108, "x").detail).toBeUndefined();
  });
});
