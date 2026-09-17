/**
 * 「普通に zod を使っているプロダクト」に入れるときの噛み合わせを固定するテスト。
 * ここが壊れると導入時に事故る箇所なので、意図をコメントで残しておく。
 */
import * as Z from "zod";
import type { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { createJevZod, getSemanticIssues } from "../src/index.js";
import { answering, recordingFetch, testConfig } from "./helpers.js";

const RULE = "本文が妥当である";

const semanticIssues = (result: { success: boolean; error?: unknown }) =>
  result.success ? [] : getSemanticIssues(result.error as ZodError);

function setup(handler: Parameters<typeof recordingFetch>[0] = answering({ [RULE]: 0.01 })) {
  const recorder = recordingFetch(handler);
  const z = createJevZod(testConfig(recorder));
  return { recorder, z };
}

describe("既存の Zod コードとの噛み合わせ", () => {
  it("素の zod を使ったまま semantic だけ持ち込める", async () => {
    const recorder = recordingFetch(answering({ [RULE]: 0.99 }));
    // z を差し替えず、必要な関数だけ取り出す（既存の `import { z } from "zod"` を維持できる）
    const { semantic } = createJevZod(testConfig(recorder));

    const Checked = semantic(Z.object({ body: Z.string() }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);
    const result = await Checked.safeParseAsync({ body: "x" });

    expect(result.success).toBe(true);
    expect(recorder.calls).toHaveLength(1);
  });

  it("返り値は base と同じ型なので .safeExtend() などのオブジェクト操作が使える", async () => {
    const { recorder, z } = setup();
    const Base = z.object({ body: z.string(), keep: z.string() });
    const Checked = z.semantic(Base, [{ id: "ok", is: RULE, message: "不正" }]);

    // ZodObject のメソッドが残っている（ZodPipe にすると型エラーになる箇所）。
    // `.extend()` は zod 4.3〜4.5 では refine 付き object に対して拒否されるので、
    // どのバージョンでも安全な `.safeExtend()` を使う（4.6 以降は `.extend()` も可）。
    const Extended = Checked.safeExtend({ extra: z.string() });
    const Strict = Checked.strict();

    expect((await Extended.safeParseAsync({ body: "x", keep: "k", extra: "e" })).success).toBe(
      false,
    );
    expect((await Strict.safeParseAsync({ body: "x", keep: "k" })).success).toBe(false);
    // どちらも refine を引き継いでいて、2 回リクエストが飛ぶ
    expect(recorder.calls).toHaveLength(2);
  });

  it(".pick() / .omit() / .partial() / .merge() は refine 付きでは Zod が拒否するので、先に適用する", async () => {
    const { recorder, z } = setup();
    const Base = z.object({ body: z.string(), keep: z.string() });
    const Checked = z.semantic(Base, [{ id: "ok", is: RULE, message: "不正" }]);

    // Zod 4 本体のガード（このライブラリ固有ではない）。refine を安全に移せないため。
    expect(() => Checked.pick({ body: true })).toThrow(/refinements/);
    expect(() => Checked.omit({ keep: true })).toThrow(/refinements/);
    expect(() => Checked.partial()).toThrow(/refinements/);

    // 回避策: 先に形を絞ってから semantic を付ける。
    const Picked = z.semantic(Base.pick({ body: true }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);
    expect((await Picked.safeParseAsync({ body: "x" })).success).toBe(false);
    expect(recorder.calls).toHaveLength(1);
  });

  it("base 自体は変更しない（元のスキーマは同期 parse のまま）", () => {
    const { recorder, z } = setup();
    const Base = z.object({ body: z.string() });
    const Checked = z.semantic(Base, [{ id: "ok", is: RULE, message: "不正" }]);

    expect(Checked).not.toBe(Base);
    expect(Base.safeParse({ body: "x" }).success).toBe(true); // 同期 parse が通る = 未汚染
    expect(recorder.calls).toHaveLength(0);
  });

  it("構造化出力用の JSON Schema 変換を壊さない", () => {
    const { z } = setup();
    const Checked = z.semantic(z.object({ body: z.string(), n: z.number() }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);

    // 既定は output モード。ZodPipe 実装だと "Custom types cannot be represented" で落ちていた。
    expect(Z.toJSONSchema(Checked)).toMatchObject({
      type: "object",
      properties: { body: { type: "string" }, n: { type: "number" } },
      required: ["body", "n"],
    });
    expect(Z.toJSONSchema(Checked, { io: "input" })).toMatchObject({ type: "object" });
  });

  it("子の形式エラーがあるときはリクエストを送らない", async () => {
    const { recorder, z } = setup();
    const Checked = z.semantic(z.object({ body: z.string() }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);

    const result = await Checked.safeParseAsync({ body: 1 as never });

    expect(result.success).toBe(false);
    expect(recorder.calls).toHaveLength(0);
    expect(semanticIssues(result)).toEqual([]);
  });

  it("親オブジェクトの中で使っても、地の値はそのまま返る", async () => {
    const { z } = setup(answering({ [RULE]: 0.99 }));
    const Checked = z.semantic(z.object({ body: z.string() }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);
    const Parent = z.object({ id: z.string(), check: Checked });

    const result = await Parent.safeParseAsync({ id: "1", check: { body: "x" } });

    expect(result.success && result.data).toEqual({ id: "1", check: { body: "x" } });
  });

  it("別フィールドの形式エラーがあっても、その semantic の判定は走る（Zod の構造上の割り切り）", async () => {
    const { recorder, z } = setup(answering({ [RULE]: 0.99 }));
    const Checked = z.semantic(z.object({ body: z.string() }), [
      { id: "ok", is: RULE, message: "不正" },
    ]);
    const Parent = z.object({ id: z.string(), check: Checked });

    const result = await Parent.safeParseAsync({ id: 1 as never, check: { body: "x" } });

    // 全体は形式エラーで落ちるが、検証済みの check に対しては JEV が呼ばれる。
    // 無駄な課金を避けたい場合は、base を先に parse してから semantic 層を別に走らせる。
    expect(result.success).toBe(false);
    expect(recorder.calls).toHaveLength(1);
  });
});
