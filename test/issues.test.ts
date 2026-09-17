import * as Z from "zod";
import { describe, expect, it } from "vitest";
import { createJevZod, getSemanticIssues } from "../src/index.js";
import { answering, recordingFetch, testConfig } from "./helpers.js";

describe("getSemanticIssues()", () => {
  it("形式エラーと意味エラーを分けて取り出せる", async () => {
    const recorder = recordingFetch(answering({ "条件A": 0.01 }));
    const z = createJevZod(testConfig(recorder));
    const schema = z.object({
      items: z.array(
        z.semantic(z.object({ body: z.string() }), [
          { id: "a", is: "条件A", message: "A が不正", path: ["body"] },
        ]),
      ),
    });

    const result = await schema.safeParseAsync({ items: [{ body: "x" }, { body: 42 }] });

    expect(result.success).toBe(false);
    if (result.success) return;

    // 意味エラーだけが取り出され、パスは基底スキーマの位置を含む。
    const semantic = getSemanticIssues(result.error);
    expect(semantic).toEqual([
      {
        path: ["items", 0, "body"],
        message: "A が不正",
        details: { kind: "rejected", ruleId: "a", probability: 0.01, threshold: 0.95 },
      },
    ]);

    // 形式エラーは Zod の issue として残っている。
    expect(result.error.issues.length).toBeGreaterThan(semantic.length);
    expect(
      result.error.issues.some((issue) => issue.code === "invalid_type"),
    ).toBe(true);
  });

  it("semantic の params が無い issue は無視する", () => {
    const untouched = Z.string().refine(() => false, { message: "別の refine" });
    const broken = Z.string().refine(() => false, {
      message: "壊れた params",
      params: { semantic: { kind: "?" } },
    });

    const first = untouched.safeParse("x");
    const second = broken.safeParse("x");
    if (first.success || second.success) throw new Error("expected failures");

    expect(getSemanticIssues(first.error)).toEqual([]);
    expect(getSemanticIssues(second.error)).toEqual([]);
  });

  it("unavailable も details として取り出せる", async () => {
    const recorder = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const z = createJevZod(testConfig(recorder));
    const schema = z.semantic(z.object({ body: z.string() }), [
      { id: "a", is: "条件A", message: "A が不正" },
    ]);

    const result = await schema.safeParseAsync({ body: "x" });
    if (result.success) throw new Error("expected failure");

    expect(getSemanticIssues(result.error)[0]!.details).toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });
});
