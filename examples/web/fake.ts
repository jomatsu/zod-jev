/**
 * `--fake` で起動したときに使う、JEV の代わりの中身と、デモ用の出品サンプル。
 *
 * 偽の fetch は入力の特徴から「それらしい」確率を返すだけのものです。JEV の精度を
 * 再現するものではなく、鍵も課金も無しで画面と分岐を確認するためのものです。
 */
import { ListingRules } from "./listing.js";

const base = {
  shippingFee: "送料込み（出品者負担）",
  shippingDays: "2〜3日で発送",
};

export const samples = [
  {
    label: "良い出品（そのまま出品できる）",
    photo: true,
    updated: "9/17 09:41",
    listing: {
      ...base,
      title: "SONY α7 III ボディ＋標準ズームレンズ",
      body: "2023年に購入し、年に数回使いました。シャッター回数は約8,000回です。レンズ（FE 28-70mm）と純正バッテリー2個、充電器、元箱が付属します。室内で保管していたため、目立つ傷や汚れはありません。",
      category: "家電・スマホ・カメラ",
      condition: "目立った傷や汚れなし",
      price: 58000,
    },
  },
  {
    label: "説明に連絡先を書いた",
    photo: true,
    updated: "9/16 21:12",
    listing: {
      ...base,
      title: "カメラ レンズセット",
      body: "α7III と標準ズームのセットです。質問があれば 090-1234-5678 か camera@example.com までご連絡ください。状態は良好です。",
      category: "家電・スマホ・カメラ",
      condition: "未使用に近い",
      price: 62000,
    },
  },
  {
    label: "出品できない物（市販薬）",
    photo: false,
    updated: "9/16 18:03",
    listing: {
      ...base,
      title: "市販の解熱剤 まとめ売り",
      body: "家に余っていた市販薬（解熱剤・胃薬）をまとめて出品します。使用期限は2027年です。未開封のまま保管していました。",
      category: "その他",
      condition: "新品、未使用",
      price: 1500,
    },
  },
  {
    label: "カテゴリーが違う",
    photo: true,
    updated: "9/15 22:47",
    listing: {
      ...base,
      title: "SONY α7 III カメラ本体",
      body: "α7III の本体のみです。バッテリーと充電器が付属します。大きな傷はなく、動作も問題ありません。",
      category: "レディース",
      condition: "目立った傷や汚れなし",
      price: 52000,
    },
  },
  {
    label: "状態と説明が矛盾している",
    photo: true,
    updated: "9/15 20:15",
    listing: {
      ...base,
      title: "ミラーレスカメラ レンズ付き",
      body: "レンズに大きなカビと目立つ傷があります。ボディは水没歴があります。動作は未確認です。それでもよろしければどうぞ。",
      category: "家電・スマホ・カメラ",
      condition: "目立った傷や汚れなし",
      price: 48000,
    },
  },
  {
    label: "価格が相場から外れている",
    photo: true,
    updated: "9/14 11:26",
    listing: {
      ...base,
      title: "SONY α7 III と FE 24-70mm GM のセット",
      body: "α7III と FE 24-70mm F2.8 GM のセットです。2024年購入、使用回数は少なめです。付属品は全て揃っています。",
      category: "家電・スマホ・カメラ",
      condition: "未使用に近い",
      price: 500,
    },
  },
  {
    label: "説明が薄い",
    photo: true,
    updated: "9/14 08:52",
    listing: {
      ...base,
      title: "カメラ",
      body: "カメラです。よろしくお願いします。",
      category: "家電・スマホ・カメラ",
      condition: "やや傷や汚れあり",
      price: 30000,
    },
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
    const price = Number(value.price ?? 0);
    const condition = String(value.condition ?? "");
    const category = String(value.category ?? "");
    const cameraish = /カメラ|レンズ|α7|ミラーレス|一眼/.test(text);

    const probabilities: Record<string, number> = {
      no_prohibited_items: /市販薬|解熱剤|胃薬|コピー品|偽物|ギフトカード|アカウント譲渡|現金/.test(text)
        ? 0.02
        : 0.99,
      no_contact_or_external: /0\d{1,4}-\d{2,4}-\d{3,4}|[\w.+-]+@[\w-]+\.[a-z]{2,}|https?:\/\//i.test(text)
        ? 0.02
        : 0.99,
      category_matches_item:
        (cameraish && category !== "家電・スマホ・カメラ") ||
        (/ドレス|ワンピース|コート/.test(text) && category !== "レディース")
          ? 0.05
          : 0.99,
      condition_matches_description:
        /目立った傷や汚れなし|未使用に近い|新品、未使用/.test(condition) &&
        /カビ|大きな傷|水没|欠品|割れ/.test(body)
          ? 0.05
          : 0.99,
      price_is_plausible: (cameraish && price < 5000) || price >= 5_000_000 ? 0.05 : 0.99,
      // 短い説明は「十分かどうか」の判断が割れる（= uncertain 帯）
      description_is_sufficient: body.length < 40 ? 0.5 : 0.95,
    };

    const answers = Object.fromEntries(
      Object.keys(request.questions ?? {}).map((key) => {
        const index = Number(key.replace(/^q/, ""));
        const id = ListingRules[index]?.id;
        return [key, { type: "noul", noul: id === undefined ? 0.99 : (probabilities[id] ?? 0.99) }];
      }),
    );

    return new Response(
      JSON.stringify({
        model: "fake-model-0.0.0",
        answers,
        usage: { input_tokens: 720, output_tokens: 34 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
}
