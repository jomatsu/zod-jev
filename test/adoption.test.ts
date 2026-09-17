/**
 * 導入の実例（examples/adoption）の振る舞いを固定するテスト。
 * アプリ側の「落ち方ごとの扱い」はアプリが決める、という線引きをここで守る。
 */
import { describe, expect, it, vi } from "vitest";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createIntake, TicketRules, type IntakeMode } from "../examples/adoption/intake.js";
import { answering, jsonResponse, recordingFetch } from "./helpers.js";

const rule = (id: string) => {
  const found = TicketRules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`unknown rule: ${id}`);
  return found.is;
};

const input = {
  subject: "二重請求",
  body: "A-104 の注文で二重に請求されています。重複分の返金手続きを教えてください。",
};

function setup(
  handler: Parameters<typeof recordingFetch>[0],
  mode: IntakeMode,
  options: { onIssues?: (issues: readonly unknown[]) => void } = {},
) {
  const recorder = recordingFetch(handler);
  // テストでは公式 SDK のクライアントを注入してリトライ待ちをゼロにする
  // （実プロダクトでは、ここで logLevel や retry 方針を集中管理できる）
  const client = new TypeSafeClient({
    apiKey: "test-key",
    fetch: recorder.fetch,
    retry: { backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
  });
  const intake = createIntake({
    mode,
    client,
    ...(options.onIssues === undefined ? {} : { onIssues: options.onIssues }),
  });
  return { recorder, intake };
}

describe("導入の実例（ticket intake）", () => {
  it("off は JEV を呼ばず、鍵も要らない（キルスイッチ）", async () => {
    const recorder = recordingFetch(answering());
    const intake = createIntake({ mode: "off", fetch: recorder.fetch });

    const result = await intake(input);

    expect(result.status).toBe("accepted");
    expect(recorder.calls).toHaveLength(0);
  });

  it("shadow は呼ぶが挙動を変えず、issue だけを記録する", async () => {
    const seen: unknown[] = [];
    const { recorder, intake } = setup(
      answering({ [rule("no_pii_in_body")]: 0.02 }),
      "shadow",
      { onIssues: (issues) => seen.push(...issues) },
    );

    const result = await intake(input);

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.review).toBe(false);
    expect(recorder.calls).toHaveLength(1);
    expect(seen).toHaveLength(1); // 本番データで閾値を調整するための記録
  });

  it("enforce は rejected をメッセージ付きで差し戻す", async () => {
    const { intake } = setup(answering({ [rule("no_pii_in_body")]: 0.01 }), "enforce");

    const result = await intake(input);

    expect(result).toMatchObject({
      status: "rejected",
      message: "本文に個人情報が含まれています。マスクしてから処理してください。",
    });
  });

  it("enforce は uncertain を「受け付けてレビュー」に向ける（可用性優先）", async () => {
    const { intake } = setup(answering({ [rule("self_service_ready")]: 0.5 }), "enforce");

    const result = await intake(input);

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.review).toBe(true);
      expect(result.issues[0]!.details.kind).toBe("uncertain");
    }
  });

  it("enforce は JEV 障害でも入力を受け、レビューに回す（fail-open の判断はアプリ側）", async () => {
    const onResponse = vi.fn();
    const recorder = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new TypeSafeClient({
      apiKey: "test-key",
      fetch: recorder.fetch,
      retry: { backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
    });
    const intake = createIntake({ mode: "enforce", client, onResponse });

    const result = await intake(input);

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.review).toBe(true);
      expect(result.issues[0]!.details).toEqual({ kind: "unavailable", reason: "network" });
    }
    expect(recorder.calls).toHaveLength(3); // SDK のリトライは働いている
    expect(onResponse).not.toHaveBeenCalled(); // 応答が無いので計測も無い
  });

  it("形が壊れている入力では JEV を呼ばない", async () => {
    const { recorder, intake } = setup(answering(), "enforce");

    const result = await intake({ subject: "", body: "" });

    expect(result.status).toBe("invalid");
    expect(recorder.calls).toHaveLength(0);
  });

  it("形が正しく判定も通れば、そのまま受け付ける", async () => {
    const { intake } = setup(answering(), "enforce");

    const result = await intake(input);

    expect(result).toMatchObject({ status: "accepted", review: false });
  });

  it("応答が壊れていても合格にはしない", async () => {
    // model と answers はあるが、どの質問にも回答が入っていない応答
    const { intake } = setup(
      () => jsonResponse({ model: "jev-latest", answers: {} }),
      "enforce",
    );

    const result = await intake(input);

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.review).toBe(true);
      expect(result.issues).toHaveLength(TicketRules.length);
      expect(result.issues[0]!.details.kind).toBe("unavailable");
    }
  });
});
