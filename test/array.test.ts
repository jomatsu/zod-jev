import type { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { createJevZod, getSemanticIssues } from "../src/index.js";
import {
  answering,
  answeringPerQuestion,
  jsonResponse,
  readQuestions,
  recordingFetch,
  testConfig,
} from "./helpers.js";

const OK = "要素が妥当である";
const TONE = "丁寧な表現である";

const semanticIssues = (result: { success: boolean; error?: unknown }) =>
  result.success ? [] : getSemanticIssues(result.error as ZodError);

function setup(handler: Parameters<typeof recordingFetch>[0], overrides = {}) {
  const recorder = recordingFetch(handler);
  const z = createJevZod(testConfig(recorder, overrides));
  return { recorder, z };
}

const item = (text: string) => ({ text });

describe("semanticArray()", () => {
  it("要素をまとめて1リクエストに載せ、要素ごとの質問を作る", async () => {
    const { recorder, z } = setup(answering());

    const schema = z.semanticArray(z.object({ text: z.string() }), [
      { id: "ok", is: OK, message: "不正", path: ["text"] },
    ]);
    const result = await schema.safeParseAsync([item("a"), item("b"), item("c")]);

    expect(result.success).toBe(true);
    expect(recorder.calls).toHaveLength(1);

    const call = recorder.calls[0]!;
    expect(call.body.state.value).toEqual([item("a"), item("b"), item("c")]);
    const questions = readQuestions(call.body);
    expect(questions.map((q) => q.key)).toEqual(["q0c0", "q1c0", "q2c0"]);
    expect(questions.map((q) => q.raw.instructions.judge)).toEqual([
      "value[0]",
      "value[1]",
      "value[2]",
    ]);
  });

  it("失敗した要素だけに issue を付け、パスに添字を入れる", async () => {
    const { recorder, z } = setup(answeringPerQuestion(({ index }) => (index === 1 ? 0.01 : 0.99)));

    const schema = z.semanticArray(z.object({ text: z.string() }), [
      { id: "ok", is: OK, message: "表現が不正", path: ["text"] },
    ]);
    const issues = semanticIssues(await schema.safeParseAsync([item("a"), item("b"), item("c")]));

    expect(recorder.calls).toHaveLength(1);
    expect(issues).toEqual([
      {
        path: [1, "text"],
        message: "表現が不正",
        details: { kind: "rejected", ruleId: "ok", probability: 0.01, threshold: 0.95 },
      },
    ]);
  });

  it("要素数 × 条件数が上限を超えたら分割して送る", async () => {
    const { recorder, z } = setup(answering());

    const schema = z.semanticArray(
      z.object({ text: z.string() }),
      [
        { id: "ok", is: OK, message: "不正", path: ["text"] },
        { id: "tone", is: TONE, message: "口調が不正", path: ["text"] },
      ],
      { maxQuestionsPerRequest: 4 },
    );

    const items = [1, 2, 3, 4, 5].map((n) => item(String(n)));
    const result = await schema.safeParseAsync(items);

    expect(result.success).toBe(true);
    // 1リクエストあたり2要素（4質問）なので 2 + 2 + 1 の3回。
    expect(recorder.calls).toHaveLength(3);
    const sizes = recorder.calls.map((call) => call.body.state.value.length);
    expect(sizes).toEqual([2, 2, 1]);
    for (const call of recorder.calls) {
      expect(readQuestions(call.body)).toHaveLength(call.body.state.value.length * 2);
    }
    // 最後のリクエストの中の1件目は、配列全体では4番目（添字4）。
    const last = readQuestions(recorder.calls[2]!.body)[0]!;
    expect(last.raw.instructions.judge).toBe("value[0]");
  });

  it("空配列では API を呼ばない", async () => {
    const { recorder, z } = setup(answering());

    const schema = z.semanticArray(z.object({ text: z.string() }), [
      { id: "ok", is: OK, message: "不正" },
    ]);
    const result = await schema.safeParseAsync([]);

    expect(result.success).toBe(true);
    expect(recorder.calls).toHaveLength(0);
  });

  it("要素ごとの toJSON を適用する", async () => {
    const { recorder, z } = setup(answering());
    const at = new Date("2026-09-17T00:00:00.000Z");

    const schema = z.semanticArray(
      z.object({ at: z.date() }),
      [{ id: "ok", is: OK, message: "不正" }],
      { toJSON: (value) => ({ at: value.at.toISOString() }) },
    );
    await schema.safeParseAsync([{ at }]);

    expect(recorder.calls[0]!.body.state.value).toEqual([{ at: "2026-09-17T00:00:00.000Z" }]);
  });

  it("分割しても全体で1つの issue 一覧になる", async () => {
    const { z } = setup(
      answeringPerQuestion(({ body }) => (body.state.value[0]?.text === "bad" ? 0.01 : 0.99)),
    );

    const schema = z.semanticArray(
      z.object({ text: z.string() }),
      [{ id: "ok", is: OK, message: "不正", path: ["text"] }],
      { maxQuestionsPerRequest: 1 },
    );
    const issues = semanticIssues(
      await schema.safeParseAsync([item("good"), item("bad"), item("also good")]),
    );

    expect(issues.map((issue) => issue.path)).toEqual([[1, "text"]]);
  });

  it("JSON 化できない要素は not_json として落とす", async () => {
    const { recorder, z } = setup(answering());

    const schema = z.semanticArray(z.object({ at: z.date() }), [
      { id: "ok", is: OK, message: "不正" },
    ]);
    const issues = semanticIssues(await schema.safeParseAsync([{ at: new Date() }]));

    expect(recorder.calls).toHaveLength(0);
    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "not_json" });
  });

  it("要素の形式エラーでは API を呼ばない", async () => {
    const { recorder, z } = setup(() => jsonResponse({ model: "x", answers: {} }));

    const schema = z.semanticArray(z.object({ text: z.string() }), [
      { id: "ok", is: OK, message: "不正" },
    ]);
    const result = await schema.safeParseAsync([{ text: 1 }]);

    expect(result.success).toBe(false);
    expect(recorder.calls).toHaveLength(0);
  });
});
