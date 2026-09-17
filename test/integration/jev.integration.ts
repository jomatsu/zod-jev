/**
 * 実際の TypeSafe Jev に対して動くことを確かめるテスト。
 *
 * - 実行には `TYPESAFE_API_KEY`（または `.env`）が必要。
 * - 課金が発生する（1リクエストあたり $0.0001 未満）。`npm run test:integration` で明示的に走らせる。
 * - 既定の `npm test` では実行されない。
 */
import { describe, expect, it, vi } from "vitest";
import { AuthenticationError, createJevZod, getSemanticIssues } from "../../src/index.js";

const apiKey = process.env.TYPESAFE_API_KEY;
const describeIfKey = apiKey === undefined || apiKey === "" ? describe.skip : describe;

describeIfKey("実 API（TypeSafe Jev）", () => {
  it("条件をまとめて1リクエストで判定し、成立しない条件だけを落とす", async () => {
    const onResponse = vi.fn();
    const z = createJevZod({ apiKey, onResponse, retry: { backoffInitialMs: 0 } });
    const schema = z.semantic(
      z.object({ message: z.string() }),
      [
        {
          id: "refund_requested",
          is: "`value.message` asks for a refund or a reversal of a charge.",
          message: "返金依頼として扱えませんでした。",
          path: ["message"],
          threshold: 0.8,
        },
        {
          id: "has_contact_info",
          is: "`value.message` contains an email address or a phone number.",
          message: "本文に連絡先が含まれています。",
          path: ["message"],
          threshold: 0.8,
        },
      ],
      { context: { note: "Support triage. Only the text in `value.message` counts." } },
    );

    const result = await schema.safeParseAsync({
      message:
        "My card was charged twice for order A-104. Please refund the duplicate charge.",
    });

    // 返金依頼は明確なので通り、連絡先の条件だけが落ちる。
    expect(result.success, "expected the contact-info condition to fail").toBe(false);
    if (result.success) return;

    const issues = getSemanticIssues(result.error);
    expect(
      issues.map((issue) => ("ruleId" in issue.details ? issue.details.ruleId : "unavailable")),
      `observed: ${JSON.stringify(issues)}`,
    ).toEqual(["has_contact_info"]);

    const details = issues[0]!.details;
    if (details.kind === "unavailable") throw new Error("expected a judgment, got unavailable");
    expect(details.probability).toBeLessThan(0.8);
    expect(details.threshold).toBe(0.8);

    // 実際にモデルが応答し、トークンが計上されている。
    expect(onResponse).toHaveBeenCalledTimes(1);
    const info = onResponse.mock.calls[0]![0];
    // 応答の model はエイリアスではなく解決済みのモデル ID（例: `jev-1.13.0`）。
    expect(info.model).toMatch(/^jev-/);
    expect(info.questionCount).toBe(2);
    expect(info.inputTokens).toBeGreaterThan(0);
    expect(info.latencyMs).toBeGreaterThan(0);
  });

  it("すべての条件が成立すれば値がそのまま通る", async () => {
    const z = createJevZod({ apiKey });
    const schema = z.semantic(
      z.object({ message: z.string() }),
      [
        {
          id: "is_complaint",
          is: "`value.message` reports a problem with a product or a service.",
          message: "苦情として扱えませんでした。",
          threshold: 0.8,
        },
      ],
    );

    const result = await schema.safeParseAsync({
      message: "The desk I ordered two weeks ago still has not shipped. This is unacceptable.",
    });

    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
    if (result.success) {
      expect(result.data.message).toContain("still has not shipped");
    }
  });

  it("API キーが不正なら設定エラーとして例外になる", async () => {
    const z = createJevZod({ apiKey: "invalid-key", retry: { maxRetries: 0 } });
    const schema = z.semantic(
      z.object({ message: z.string() }),
      [{ id: "any", is: "`value.message` is not empty.", message: "空です。" }],
    );

    await expect(schema.safeParseAsync({ message: "hello" })).rejects.toThrow(
      AuthenticationError,
    );
  });
});
