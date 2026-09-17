/**
 * デモ web アプリ（出品画面の裏で JEV が判定する）の振る舞いを固定するテスト。
 * 「利用者には普通のフォームのエラーと結果だけを見せる」線引きを守る。
 */
import { describe, expect, it } from "vitest";
import { createListingService, ListingRules, type ListingMode } from "../examples/web/listing.js";
import { answering, recordingFetch } from "./helpers.js";

const rule = (id: string) => {
  const found = ListingRules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`unknown rule: ${id}`);
  return found.is;
};

const draft = {
  title: "SONY α7 III ボディ＋標準ズームレンズ",
  body: "2023年に購入し、年に数回使いました。レンズと純正バッテリー2個、充電器、元箱が付属します。外観は小さな擦り傷が数箇所ありますが、動作は問題ありません。",
  category: "家電・スマホ・カメラ",
  condition: "目立った傷や汚れなし",
  shippingFee: "送料込み（出品者負担）",
  shippingDays: "2〜3日で発送",
  price: 58000,
};

function setup(handler: Parameters<typeof recordingFetch>[0], mode: ListingMode = "enforce") {
  const recorder = recordingFetch(handler);
  const service = createListingService({
    mode,
    apiKey: "test-key",
    fetch: recorder.fetch,
    nextId: () => "m00000000001",
    now: () => new Date("2026-09-17T12:00:00.000Z"),
  });
  return { recorder, service };
}

describe("出品画面の裏側（listing service）", () => {
  it("形式エラーは普通のフィールドエラーにして、JEV は呼ばない", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.submit({ ...draft, title: "", body: "短い", price: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 形式エラーのときは判定していないので record は無い
    expect(result.record).toBeUndefined();
    expect(result.fieldErrors.title).toEqual(["商品名を入力してください"]);
    expect(result.fieldErrors.body).toEqual(["商品の説明は10文字以上で入力してください"]);
    expect(result.fieldErrors.price).toEqual(["価格は300円以上で入力してください"]);
    expect(recorder.calls).toHaveLength(0);
    expect(await service.list()).toHaveLength(0);
  });

  it("すべて成立すれば「公開中」で出品できる", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.submit(draft);

    expect(result).toMatchObject({ ok: true, status: "published", id: "m00000000001" });
    // デモ操作パネル用に、裏側の判定内容も一緒に返す
    expect(result.record).toMatchObject({ status: "published", issues: [] });
    expect(result.record!.jev.questionCount).toBe(ListingRules.length);
    // 6 条件を 1 リクエストにまとめて送る
    expect(recorder.calls).toHaveLength(1);
    expect(Object.keys(recorder.calls[0]!.body.questions)).toHaveLength(ListingRules.length);
    // 写真は state に載せない
    expect(recorder.calls[0]!.body.state.value).toEqual({
      title: draft.title,
      body: draft.body,
      category: draft.category,
      condition: draft.condition,
      price: draft.price,
    });

    const [saved] = await service.list();
    expect(saved).toMatchObject({ id: "m00000000001", status: "published" });
    expect(saved!.jev.questionCount).toBe(ListingRules.length);
    expect(saved!.jev.answers).not.toBeNull();
  });

  it("出品不可の理由は該当フィールドの下に出し、記録には残す", async () => {
    const { service } = setup(answering({ [rule("no_prohibited_items")]: 0.03 }));

    const result = await service.submit(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.body).toEqual([
      "出品できない商品が含まれています。出品ガイドラインをご確認ください。",
    ]);
    expect(result.record).toMatchObject({ status: "rejected" });
    expect(result.record!.issues[0]!.details).toMatchObject({
      kind: "rejected",
      ruleId: "no_prohibited_items",
      probability: 0.03,
    });
    expect((await service.list())[0]).toMatchObject({ status: "rejected" });
  });

  it("カテゴリー違いは category にエラーを付ける", async () => {
    const { service } = setup(answering({ [rule("category_matches_item")]: 0.04 }));

    const result = await service.submit(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.category).toEqual([
      "カテゴリーが商品の内容と一致していません。選び直してください。",
    ]);
    expect(result.fieldErrors.body).toBeUndefined();
  });

  it("価格や説明の判断が割れたら、利用者には何も見せず「審査中」で受け付ける", async () => {
    const { service } = setup(
      answering({
        [rule("price_is_plausible")]: 0.6,
        [rule("description_is_sufficient")]: 0.5,
      }),
    );

    const result = await service.submit(draft);

    expect(result).toMatchObject({ ok: true, status: "review" });
    const [saved] = await service.list();
    expect(saved!.status).toBe("review");
    expect(saved!.issues.every((issue) => issue.details.kind !== "rejected")).toBe(true);
  });

  it("shadow は記録だけして挙動を変えない（公開中のまま）", async () => {
    const { recorder, service } = setup(
      answering({ [rule("no_prohibited_items")]: 0.02 }),
      "shadow",
    );

    const result = await service.submit(draft);

    expect(result).toMatchObject({ ok: true, status: "published" });
    expect(recorder.calls).toHaveLength(1);
    expect((await service.list())[0]).toMatchObject({ mode: "shadow", status: "published" });
    expect((await service.list())[0]!.issues).toHaveLength(1);
  });

  it("off は JEV を呼ばず、鍵が無くても動く（キルスイッチ）", async () => {
    const service = createListingService({ mode: "off", nextId: () => "m00000000009" });

    const result = await service.submit(draft);

    expect(result).toMatchObject({ ok: true, status: "published", id: "m00000000009" });
    const [saved] = await service.list();
    expect(saved!.issues).toEqual([]);
    expect(saved!.jev.questions).toBeNull();
  });

  it("途中チェックは必要なフィールドが揃った条件だけを聞き、記録は残さない", async () => {
    const { recorder, service } = setup(answering());

    // 説明だけ入力した状態（カテゴリー・状態・価格は未入力）
    const result = await service.precheck({ title: draft.title, body: draft.body });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 聞く条件は body / title だけで足りる 3 つ。answers に入る質問数もそれに一致する
    const outcomes = Object.fromEntries(result.judgment.rules.map((r) => [r.ruleId, r.outcome]));
    expect(outcomes).toEqual({
      no_prohibited_items: "ok",
      no_contact_or_external: "ok",
      category_matches_item: "skipped",
      condition_matches_description: "skipped",
      price_is_plausible: "skipped",
      description_is_sufficient: "ok",
    });
    expect(Object.keys(recorder.calls[0]!.body.questions)).toHaveLength(3);
    expect(result.judgment.origin).toBe("precheck");
    expect(result.judgment.status).toBe("checked");

    // 保存はしない（/ops の一覧は増えない）
    expect(await service.list()).toEqual([]);
  });

  it("途中チェックは未入力のフィールドで落ちた形のエラーも返す", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.precheck({ title: draft.title, body: "短い" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.body).toEqual(["商品の説明は10文字以上で入力してください"]);
    expect(recorder.calls).toHaveLength(0); // 形が足りないので JEV は呼ばない
  });

  it("空欄は「まだ入力していない」として扱い、その条件は聞かない", async () => {
    const { recorder, service } = setup(answering());

    // 価格が空欄（フォーム上はそうなる）。不正値として弾かず、価格の条件をスキップする
    const result = await service.precheck({ ...draft, price: "" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const priceRule = result.judgment.rules.find((r) => r.ruleId === "price_is_plausible");
    expect(priceRule!.outcome).toBe("skipped");
    expect(Object.keys(recorder.calls[0]!.body.questions)).toHaveLength(ListingRules.length - 1);
  });

  it("何も入力していなければ JEV を呼ばない", async () => {
    const { recorder, service } = setup(answering());

    const result = await service.precheck({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgment.rules.every((rule) => rule.outcome === "skipped")).toBe(true);
    expect(result.judgment.jev.questionCount).toBe(0);
    expect(recorder.calls).toHaveLength(0);
  });

  it("途中チェックでも違反は該当フィールド付きで返る（インライン表示用）", async () => {
    const { service } = setup(answering({ [rule("no_contact_or_external")]: 0.02 }));

    const result = await service.precheck({ title: draft.title, body: draft.body });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failed = result.judgment.rules.find((r) => r.ruleId === "no_contact_or_external");
    expect(failed).toMatchObject({ field: "body", outcome: "rejected", probability: 0.02 });
    expect(failed!.message).toContain("連絡先や外部サイトの記載はできません");
  });

  it("記録は上限までで古いものから捨てる", async () => {
    let n = 0;
    const service = createListingService({
      mode: "off",
      limit: 2,
      nextId: () => `m0000000000${++n}`,
    });

    await service.submit(draft);
    await service.submit(draft);
    await service.submit(draft);

    expect((await service.list()).map((record) => record.id)).toEqual([
      "m00000000003",
      "m00000000002",
    ]);
  });
});
