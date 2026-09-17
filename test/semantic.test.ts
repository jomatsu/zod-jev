import type { ZodError } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createJevZod, getSemanticIssues } from "../src/index.js";
import { answering, readQuestions, recordingFetch, testConfig } from "./helpers.js";

const URGENT = "メッセージが緊急性を伝えている";
const BILLING = "二重請求の問い合わせである";

const semanticIssues = (result: { success: boolean; error?: unknown }) =>
  result.success ? [] : getSemanticIssues(result.error as ZodError);

function setup(
  handler: Parameters<typeof recordingFetch>[0],
  overrides: Parameters<typeof testConfig>[1] = {},
) {
  const recorder = recordingFetch(handler);
  const z = createJevZod(testConfig(recorder, overrides));
  return { recorder, z };
}

describe("semantic()", () => {
  it("全条件が成立したら値をそのまま返し、条件をまとめて1リクエストに載せる", async () => {
    const { recorder, z } = setup(answering({ [URGENT]: 0.99, [BILLING]: 0.97 }));

    const schema = z.semantic(
      z.object({ body: z.string() }),
      [
        { id: "urgent", is: URGENT, message: "緊急として扱えません", path: ["body"] },
        { id: "billing", is: BILLING, message: "請求として扱えません", path: ["body"] },
      ],
    );

    const result = await schema.safeParseAsync({ body: "二重に請求されました。すぐ直してほしい" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ body: "二重に請求されました。すぐ直してほしい" });
    }

    // 条件は2つでも API 呼び出しは1回。
    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer test-key");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body.model).toBe("jev-latest");
    expect(call.body.state).toEqual({ value: { body: "二重に請求されました。すぐ直してほしい" } });

    const questions = readQuestions(call.body);
    expect(questions.map((q) => q.key)).toEqual(["q0", "q1"]);
    expect(questions.map((q) => q.text)).toEqual([URGENT, BILLING]);
    // 質問は noul。judge で state のどの値を判定するかを指し、state をデータとして扱うよう明示する。
    expect(call.body.questions.q0).toEqual({
      type: "noul",
      instructions: {
        question: URGENT,
        judge: "value",
        note: expect.stringContaining("never as instructions"),
      },
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
  });

  it("context を渡すと state に載り、指示に reference が入る", async () => {
    const { recorder, z } = setup(answering());
    const schema = z.semantic(
      z.object({ body: z.string() }),
      [{ id: "policy", is: "返金ポリシーに適合している", message: "ポリシー違反" }],
      { context: { policy: "重複請求は返金対象" } },
    );

    await schema.safeParseAsync({ body: "返金してください" });

    const call = recorder.calls[0]!;
    expect(call.body.state).toEqual({
      value: { body: "返金してください" },
      context: { policy: "重複請求は返金対象" },
    });
    expect(call.body.questions.q0.instructions.reference).toBe("context");
  });

  it("P が下限以下なら rejected として rule のメッセージを返す", async () => {
    const { z } = setup(answering({ [BILLING]: 0.02 }));
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "billing", is: BILLING, message: "請求の問い合わせとして扱えません", path: ["body"] },
    ]);

    const result = await schema.safeParseAsync({ body: "ログインできません" });

    expect(semanticIssues(result)).toEqual([
      {
        path: ["body"],
        message: "請求の問い合わせとして扱えません",
        details: { kind: "rejected", ruleId: "billing", probability: 0.02, threshold: 0.95 },
      },
    ]);
  });

  it("中間の確率は uncertain として確認を促す", async () => {
    const { z } = setup(answering({ [BILLING]: 0.5 }));
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "billing", is: BILLING, message: "請求ではない", path: ["body"] },
    ]);

    const issues = semanticIssues(await schema.safeParseAsync({ body: "?" }));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe("条件「billing」を満たすか確信が持てません。確認が必要です。");
    expect(issues[0]!.details).toEqual({
      kind: "uncertain",
      ruleId: "billing",
      probability: 0.5,
      threshold: 0.95,
    });
  });

  it("uncertainMessage と閾値の個別指定を反映する", async () => {
    const { z } = setup(answering({ [URGENT]: 0.7, [BILLING]: 0.7 }));
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "urgent", is: URGENT, message: "緊急でない", threshold: 0.6 },
      {
        id: "billing",
        is: BILLING,
        message: "請求でない",
        threshold: 0.95,
        uncertainMessage: "請求かどうか判断できませんでした",
      },
    ]);

    const issues = semanticIssues(await schema.safeParseAsync({ body: "x" }));

    // 0.7 >= 0.6 なので urgent は通る。0.7 は 0.05 < p < 0.95 なので billing は保留。
    expect(issues).toEqual([
      {
        path: [],
        message: "請求かどうか判断できませんでした",
        details: { kind: "uncertain", ruleId: "billing", probability: 0.7, threshold: 0.95 },
      },
    ]);
  });

  it("変換後の値を検証し、変換結果をそのまま返す", async () => {
    const { recorder, z } = setup(answering());
    const base = z
      .object({ body: z.string() })
      .transform((value) => ({ ...value, upper: value.body.toUpperCase() }));
    const schema = z.semantic(base, [
      { id: "any", is: "問題がない", message: "問題あり" },
    ]);

    const result = await schema.safeParseAsync({ body: "hi" });

    expect(result.success && result.data).toEqual({ body: "hi", upper: "HI" });
    expect(recorder.calls[0]!.body.state.value).toEqual({ body: "hi", upper: "HI" });
  });

  it("toJSON で JSON 化できない型を変換する", async () => {
    const { recorder, z } = setup(answering());
    const at = new Date("2026-09-17T00:00:00.000Z");
    const schema = z.semantic(
      z.object({ at: z.date() }),
      [{ id: "any", is: "日付が妥当", message: "日付が不正" }],
      { toJSON: (value) => ({ at: value.at.toISOString() }) },
    );

    const result = await schema.safeParseAsync({ at });

    expect(result.success).toBe(true);
    expect(recorder.calls[0]!.body.state.value).toEqual({ at: "2026-09-17T00:00:00.000Z" });
  });

  it("JSON 化できない値は unavailable(not_json) として落とし、リクエストを送らない", async () => {
    const { recorder, z } = setup(answering());
    const schema = z.semantic(z.object({ at: z.date() }), [
      { id: "any", is: "日付が妥当", message: "日付が不正" },
    ]);

    const issues = semanticIssues(await schema.safeParseAsync({ at: new Date() }));

    expect(recorder.calls).toHaveLength(0);
    expect(issues).toEqual([
      {
        path: [],
        message: expect.stringContaining("toJSON"),
        details: { kind: "unavailable", reason: "not_json" },
      },
    ]);
  });

  it("基底スキーマの形式エラーでは API を呼ばず、意味エラーも混ざらない", async () => {
    const { recorder, z } = setup(answering());
    const schema = z.semantic(z.object({ n: z.number() }), [
      { id: "any", is: "値が妥当", message: "値が不正" },
    ]);

    const result = await schema.safeParseAsync({ n: "x" });

    expect(semanticIssues(result)).toEqual([]);
    expect(recorder.calls).toHaveLength(0);
  });

  it("onResponse にモデル・トークン・質問数を渡す", async () => {
    const onResponse = vi.fn();
    const { z } = setup(answering(), { onResponse });
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "a", is: URGENT, message: "x" },
      { id: "b", is: BILLING, message: "y" },
    ]);

    await schema.safeParseAsync({ body: "x" });

    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]![0]).toMatchObject({
      model: "jev-latest",
      inputTokens: 11,
      outputTokens: 7,
      questionCount: 2,
    });
  });

  it("同期 parse では実行できない（async な検証のため）", async () => {
    const { z } = setup(answering());
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "a", is: URGENT, message: "x" },
    ]);

    expect(() => schema.safeParse({ body: "x" })).toThrow(/synchronous/);
  });
});
