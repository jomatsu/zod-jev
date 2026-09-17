/**
 * 配列を1要素ずつ意味検証する例。要素をまとめて1〜数リクエストに載せる。
 *
 *   TYPESAFE_API_KEY=... npx tsx examples/array.ts
 */
import { existsSync } from "node:fs";
import { createJevZod, getSemanticIssues } from "../src/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const z = createJevZod();

const AdCopy = z.semanticArray(
  z.object({ headline: z.string(), body: z.string() }),
  [
    {
      id: "no_medical_claim",
      is: "`value.body` が効能・効果を断定する表現（治る、必ず痩せる、など）を含んでいない",
      message: "断定表現があります。景品表示法の観点で修正してください。",
      path: ["body"],
    },
    {
      id: "readable",
      is: "`value.headline` が 40 文字以内で、体言止めや記号の羅列になっていない",
      message: "見出しが読みにくいか長すぎます。",
      path: ["headline"],
    },
  ],
  { maxQuestionsPerRequest: 64 },
);

const result = await AdCopy.safeParseAsync([
  { headline: "毎日の水分補給に", body: "続けやすい味で、1本でしっかり補給できます。" },
  { headline: "これを飲めば必ず痩せる！", body: "飲むだけで確実に痩せると話題です。" },
  { headline: "高品質・低価格・即日発送", body: "詳細は商品ページをご覧ください。" },
]);

if (result.success) {
  console.log("すべて合格:", result.data.length, "件");
} else {
  for (const issue of getSemanticIssues(result.error)) {
    console.log(`- 要素 ${issue.path[0]}: ${issue.message}`, issue.details);
  }
}
