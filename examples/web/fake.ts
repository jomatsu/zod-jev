/**
 * `--fake` で起動したときに使う、JEV の代わりの中身。
 *
 * 入力の特徴から「それらしい」確率を返すだけの偽物です。JEV の精度を再現するものではなく、
 * 鍵も課金も無しで画面と分岐を確認するためのものです。
 */
import { ReviewRules } from "./review.js";

/** 運用画面から流せるデモ用の投稿。 */
export const samples = [
  {
    label: "ふつうの良いレビュー",
    review: {
      nickname: "たろう",
      rating: 5,
      title: "組み立てが簡単",
      body: "説明書が分かりやすく、30分で組み立てられました。天板の質感も値段以上だと感じます。",
    },
  },
  {
    label: "個人情報が入っている",
    review: {
      nickname: "はなこ",
      rating: 4,
      title: "連絡先を書いてしまいました",
      body: "問い合わせは 090-1234-5678 か hanako@example.com までお願いします。商品自体は良かったです。",
    },
  },
  {
    label: "宣伝リンク入り",
    review: {
      nickname: "shop",
      rating: 5,
      title: "お得な情報",
      body: "同じ商品がこちらのサイトだと半額です。https://example.com をチェックしてください。",
    },
  },
  {
    label: "星と本文が矛盾",
    review: {
      nickname: "けんた",
      rating: 5,
      title: "星5",
      body: "届いた時点で脚が折れていて、問い合わせても返信がありません。二度と買いません。",
    },
  },
  {
    label: "内容が曖昧（審査中になる）",
    review: { nickname: "ゆき", rating: 3, title: "普通", body: "普通でした。特にありません。" },
  },
];

export function fakeFetch() {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      state?: { value?: Record<string, unknown> };
      questions?: Record<string, unknown>;
    };
    const value = request.state?.value ?? {};
    const title = String(value.title ?? "");
    const body = String(value.body ?? "");
    const text = `${title} ${body}`;
    const rating = Number(value.rating ?? 0);
    const negative = /(折れ|壊れ|返信がありません|二度と|最悪|がっかり|使えない|遅い)/.test(body);

    const probabilities: Record<string, number> = {
      no_personal_information:
        /[0-9]{2,4}-[0-9]{3,4}-[0-9]{4}|[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text) ? 0.02 : 0.99,
      no_promotion: /https?:\/\/|半額|格安|こちらのサイト/.test(body) ? 0.05 : 0.99,
      rating_matches_body: (rating >= 4 && negative) || (rating <= 2 && !negative) ? 0.05 : 0.99,
      // 短い本文は「具体的な体験が書かれている」の判断が割れる（= uncertain 帯）
      body_has_specifics: body.length < 20 ? 0.5 : 0.95,
    };

    const answers = Object.fromEntries(
      Object.keys(request.questions ?? {}).map((key) => {
        const index = Number(key.replace(/^q/, ""));
        const id = ReviewRules[index]?.id;
        return [key, { type: "noul", noul: id === undefined ? 0.99 : (probabilities[id] ?? 0.99) }];
      }),
    );

    return new Response(
      JSON.stringify({
        model: "fake-model-0.0.0",
        answers,
        usage: { input_tokens: 380, output_tokens: 28 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
}
