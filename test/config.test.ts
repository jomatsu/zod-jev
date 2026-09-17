import { describe, expect, it } from "vitest";
import { createJevZod, JevConfigError } from "../src/index.js";
import { answering, recordingFetch, testConfig } from "./helpers.js";

const z = () => createJevZod(testConfig(recordingFetch(answering())));

const validRule = { id: "a", is: "問題がない", message: "問題あり" } as const;

describe("設定の検証", () => {
  it("rule が空なら構築時に落ちる", () => {
    expect(() => z().semantic(z().object({}), [])).toThrow(JevConfigError);
    expect(() => z().semantic(z().object({}), [])).toThrow(TypeError);
  });

  it.each([
    ["id が空", { ...validRule, id: "  " }],
    ["id が重複", null],
    ["is が空", { ...validRule, is: "" }],
    ["message が空", { ...validRule, message: " " }],
    ["path が負の添字", { ...validRule, path: [-1] }],
    ["path がオブジェクト", { ...validRule, path: [{ a: 1 }] }],
    ["instructions が数値", { ...validRule, instructions: 42 }],
    ["threshold が 0.5", { ...validRule, threshold: 0.5 }],
    ["threshold が 1 超", { ...validRule, threshold: 1.2 }],
  ])("rule の %s は構築時に落ちる", (_label, rule) => {
    const builder = z();
    const rules =
      rule === null
        ? [validRule, { ...validRule, message: "別のメッセージ" }]
        : [rule as never];
    expect(() => builder.semantic(builder.object({}), rules)).toThrow(JevConfigError);
  });

  it("閾値と limits の設定を検証する", () => {
    const schema = z().object({});
    expect(() => createJevZod({ apiKey: "k", threshold: 0.5 })).toThrow(JevConfigError);
    expect(() => createJevZod({ apiKey: "k", timeoutMs: 0 })).toThrow(JevConfigError);
    expect(() => createJevZod({ apiKey: "k", maxStateCharacters: 0 })).toThrow(JevConfigError);
    expect(() => createJevZod({ apiKey: "k", maxRetries: -1 })).toThrow(JevConfigError);
    expect(() => createJevZod({ apiKey: "k", model: " " })).toThrow(JevConfigError);
    expect(() =>
      createJevZod({ apiKey: "k", onClientError: "explode" as never }),
    ).toThrow(JevConfigError);
    expect(schema).toBeDefined();
  });

  it("JSON でない context は構築時に落ちる", () => {
    const builder = z();
    expect(() =>
      builder.semantic(builder.object({}), [validRule], { context: new Date() as never }),
    ).toThrow(JevConfigError);
  });

  it("API キーが無ければ公式 SDK が設定エラーを投げる", () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => createJevZod({})).toThrow(/API key/i);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });
});
