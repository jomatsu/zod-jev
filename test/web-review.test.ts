/**
 * デモ web アプリ（普通のフォームの裏で JEV が判定する）の振る舞いを固定するテスト。
 * 「利用者には普通のエラーだけを見せる」という線引きが壊れていないかを守る。
 */
import { describe, expect, it } from "vitest";
import { createReviewService, ReviewRules, type ReviewMode } from "../examples/web/review.js";
import { answering, recordingFetch } from "./helpers.js";

const rule = (id: string) => {
  const found = ReviewRules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`unknown rule: ${id}`);
  return found.is;
};

const validReview = {
  nickname: "たろう",
  rating: "5",
  title: "組み立てが簡単",
  body: "説明書が分かりやすく、30分で組み立てられました。天板の質感も満足です。",
};

function setup(handler: Parameters<typeof recordingFetch>[0], mode: ReviewMode = "enforce") {
  const recorder = recordingFetch(handler);
  const service = createReviewService({
    mode,
    apiKey: "test-key",
    fetch: recorder.fetch,
    nextId: () => "RV-TEST",
    now: () => new Date("2026-09-17T12:00:00.000Z"),
  });
  return { recorder, service };
}

describe("フォームの裏側（review service）", () => {
  it("形式エラーは普通のフィールドエラーにして、JEV は呼ばない", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.submit({ ...validReview, nickname: "", body: "短い" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.nickname).toEqual(["ニックネームを入力してください"]);
    expect(result.fieldErrors.body).toEqual(["レビュー本文は10文字以上で入力してください"]);
    expect(recorder.calls).toHaveLength(0);
    expect(await service.list()).toHaveLength(0);
  });

  it("すべて成立すれば「掲載待ち」で受け付ける", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.submit(validReview);

    expect(result).toMatchObject({ ok: true, status: "pending", id: "RV-TEST" });
    // 条件は 1 リクエストにまとめて送る
    expect(recorder.calls).toHaveLength(1);
    expect(Object.keys(recorder.calls[0]!.body.questions)).toHaveLength(ReviewRules.length);
    // 空のメールは state に載せない
    expect(recorder.calls[0]!.body.state.value).not.toHaveProperty("email");

    const [saved] = await service.list();
    expect(saved).toMatchObject({ id: "RV-TEST", status: "pending" });
    expect(saved!.review.rating).toBe(5); // coerce 済み
    expect(saved!.jev.questionCount).toBe(ReviewRules.length);
    expect(saved!.jev.answers).not.toBeNull();
  });

  it("rejected は利用者に fieldErrors として返し、運用画面には残す", async () => {
    const { service } = setup(answering({ [rule("no_personal_information")]: 0.02 }));

    const result = await service.submit(validReview);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.body).toEqual([
      "個人情報は入力しないでください。個別のご相談はお問い合わせフォームからお願いします。",
    ]);
    // 弾いた入力も記録する（どんな投稿が差し戻されたかを見るため）
    expect((await service.list())[0]).toMatchObject({ status: "rejected" });
  });

  it("閾値に届かない条件のパスにエラーを付ける（rating の食い違い）", async () => {
    const { service } = setup(answering({ [rule("rating_matches_body")]: 0.03 }));

    const result = await service.submit(validReview);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.rating).toEqual(["評価とコメントの内容が一致していません。星の数をご確認ください。"]);
    expect(result.fieldErrors.body).toBeUndefined();
  });

  it("uncertain は利用者には何も見せず、審査中として受け付ける", async () => {
    const { service } = setup(answering({ [rule("body_has_specifics")]: 0.5 }));

    const result = await service.submit(validReview);

    expect(result).toMatchObject({ ok: true, status: "review" });
    const [saved] = await service.list();
    expect(saved!.issues.map((issue) => issue.details.kind)).toEqual(["uncertain"]);
    expect(saved!.status).toBe("review");
  });

  it("shadow は記録だけして挙動を変えない（掲載待ちのまま）", async () => {
    const { recorder, service } = setup(
      answering({ [rule("no_personal_information")]: 0.02 }),
      "shadow",
    );

    const result = await service.submit(validReview);

    expect(result).toMatchObject({ ok: true, status: "pending" });
    expect(recorder.calls).toHaveLength(1);
    expect((await service.list())[0]).toMatchObject({ mode: "shadow", status: "pending" });
    expect((await service.list())[0]!.issues).toHaveLength(1);
  });

  it("off は JEV を呼ばず、鍵が無くても動く（キルスイッチ）", async () => {
    const service = createReviewService({ mode: "off", nextId: () => "RV-OFF" });

    const result = await service.submit(validReview);

    expect(result).toMatchObject({ ok: true, status: "pending", id: "RV-OFF" });
    const [saved] = await service.list();
    expect(saved!.issues).toEqual([]);
    expect(saved!.jev.questionCount).toBe(0);
    expect(saved!.jev.questions).toBeNull();
  });

  it("記録は上限までで古いものから捨てる", async () => {
    let n = 0;
    const service = createReviewService({
      mode: "off",
      limit: 2,
      nextId: () => `RV-${++n}`,
    });

    await service.submit(validReview);
    await service.submit(validReview);
    await service.submit(validReview);

    expect((await service.list()).map((s) => s.id)).toEqual(["RV-3", "RV-2"]);
  });
});
