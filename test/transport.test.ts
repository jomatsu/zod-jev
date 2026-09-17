import { describe, expect, it } from "vitest";
import {
  APIUserAbortError,
  AuthenticationError,
  createJevZod,
  getSemanticIssues,
  UnprocessableEntityError,
} from "../src/index.js";
import type { ZodError } from "zod";
import {
  answering,
  hangingFetch,
  jsonResponse,
  recordingFetch,
  testConfig,
  type RecordedCall,
} from "./helpers.js";

const RULE = "本文が妥当である";

const semanticIssues = (result: { success: boolean; error?: unknown }) =>
  result.success ? [] : getSemanticIssues(result.error as ZodError);

function schemaWith(recorder: ReturnType<typeof recordingFetch>, overrides = {}) {
  const z = createJevZod(testConfig(recorder, overrides));
  return z.semantic(z.object({ body: z.string() }), [
    { id: "ok", is: RULE, message: "本文が不正", path: ["body"] },
  ]);
}

describe("トランスポート", () => {
  it("429 は Retry-After に従って再試行し、成功すれば合格にする", async () => {
    let attempt = 0;
    const recorder = recordingFetch((call: RecordedCall) => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({ error: "rate limited" }, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return answering()(call);
    });

    const result = await schemaWith(recorder).safeParseAsync({ body: "x" });

    expect(result.success).toBe(true);
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]!.headers["x-typesafe-retry-count"]).toBeUndefined();
    expect(recorder.calls[1]!.headers["x-typesafe-retry-count"]).toBe("1");
  });

  it("5xx をリトライし尽くしたら unavailable(http) にする", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse({ error: "overloaded" }, { status: 529, headers: { "retry-after": "0" } }),
    );

    const issues = semanticIssues(await schemaWith(recorder).safeParseAsync({ body: "x" }));

    expect(recorder.calls).toHaveLength(3); // 初回 + 既定2リトライ
    expect(issues).toEqual([
      {
        path: [],
        message: expect.stringContaining("HTTP 529"),
        details: { kind: "unavailable", reason: "http", status: 529 },
      },
    ]);
  });

  it("maxRetries を 0 にすると再試行しない", async () => {
    const recorder = recordingFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));

    await schemaWith(recorder, { maxRetries: 0 }).safeParseAsync({ body: "x" });

    expect(recorder.calls).toHaveLength(1);
  });

  it("タイムアウトは unavailable(timeout) にする", async () => {
    const recorder = hangingFetch();

    const issues = semanticIssues(
      await schemaWith(recorder, { timeoutMs: 20 }).safeParseAsync({ body: "x" }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "timeout" });
    expect(issues[0]!.message).toContain("タイムアウト");
  });

  it("接続エラーは unavailable(network) にする", async () => {
    const recorder = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });

    const issues = semanticIssues(await schemaWith(recorder).safeParseAsync({ body: "x" }));

    expect(recorder.calls).toHaveLength(3);
    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "network" });
  });

  it.each([401, 422])("%i は既定で例外にする", async (status) => {
    const recorder = recordingFetch(() => jsonResponse({ error: "nope" }, { status }));
    const schema = schemaWith(recorder);

    await expect(schema.safeParseAsync({ body: "x" })).rejects.toThrow(
      status === 401 ? AuthenticationError : UnprocessableEntityError,
    );
  });

  it("onClientError: issue なら 4xx も issue にする", async () => {
    const recorder = recordingFetch(() => jsonResponse({ error: "nope" }, { status: 401 }));

    const issues = semanticIssues(
      await schemaWith(recorder, { onClientError: "issue" }).safeParseAsync({ body: "x" }),
    );

    expect(issues).toEqual([
      {
        path: [],
        message: expect.stringContaining("HTTP 401"),
        details: { kind: "unavailable", reason: "http", status: 401 },
      },
    ]);
  });

  it("呼び出し側のキャンセルは検証結果にせず投げ直す", async () => {
    const recorder = recordingFetch((call, init) => {
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return answering()(call);
    });
    const controller = new AbortController();
    controller.abort();

    const z = createJevZod(testConfig(recorder));
    const schema = z.semantic(
      z.object({ body: z.string() }),
      [{ id: "ok", is: RULE, message: "本文が不正" }],
      { signal: controller.signal },
    );

    await expect(schema.safeParseAsync({ body: "x" })).rejects.toThrow(APIUserAbortError);
  });

  it("応答の形が違えば malformed_response にする", async () => {
    const recorder = recordingFetch(() => jsonResponse({ unexpected: true }));

    const issues = semanticIssues(await schemaWith(recorder).safeParseAsync({ body: "x" }));

    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "malformed_response" });
  });

  it("確率が 0..1 の外なら malformed_response にする", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse({ model: "jev-latest", answers: { q0: { type: "noul", noul: 1.5 } } }),
    );

    const issues = semanticIssues(await schemaWith(recorder).safeParseAsync({ body: "x" }));

    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "malformed_response" });
  });

  it("回答が欠けた条件は黙って通さない", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse({ model: "jev-latest", answers: {} }),
    );
    const z = createJevZod(testConfig(recorder));
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "a", is: RULE, message: "A が不正", path: ["body"] },
      { id: "b", is: "別の条件", message: "B が不正" },
    ]);

    const issues = semanticIssues(await schema.safeParseAsync({ body: "x" }));

    expect(issues.map((issue) => issue.details)).toEqual([
      { kind: "unavailable", reason: "malformed_response" },
      { kind: "unavailable", reason: "malformed_response" },
    ]);
    expect(issues[0]!.message).toContain("q0");
    expect(issues[0]!.path).toEqual(["body"]);
  });

  it("state が大きすぎれば API を叩かずに落とす", async () => {
    const recorder = recordingFetch(answering());

    const issues = semanticIssues(
      await schemaWith(recorder, { maxStateCharacters: 32 }).safeParseAsync({
        body: "x".repeat(100),
      }),
    );

    expect(recorder.calls).toHaveLength(0);
    expect(issues[0]!.details).toEqual({ kind: "unavailable", reason: "state_too_large" });
    expect(issues[0]!.message).toContain("大きすぎます");
  });

  it("usage が無くても判定は続ける", async () => {
    const recorder = recordingFetch(answering({}, { usage: false }));

    const result = await schemaWith(recorder).safeParseAsync({ body: "x" });

    expect(result.success).toBe(true);
  });
});
