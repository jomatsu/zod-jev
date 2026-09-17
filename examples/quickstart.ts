/**
 * 実 API を叩くサンプル。
 *
 *   TYPESAFE_API_KEY=... npx tsx examples/quickstart.ts
 *   （.env があれば自動で読む）
 */
import { existsSync } from "node:fs";
import { createJevZod, getSemanticIssues } from "../src/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const z = createJevZod({ onResponse: (info) => console.log("usage:", info) });

const Ticket = z.semantic(
  z.object({
    subject: z.string(),
    body: z.string(),
    email: z.string().email().optional(),
  }),
  [
    {
      id: "refund_requested",
      // 条件は「はい」で確率が 1 に近づく問いとして書く
      is: "`value.body` が返金や請求の取り消しを求めている",
      message: "返金依頼として扱えませんでした。",
      path: ["body"],
    },
    {
      id: "body_has_no_pii",
      is: "`value.body` に氏名・メールアドレス・電話番号などの個人情報が含まれていない",
      message: "本文に個人情報が含まれています。マスクしてから保存してください。",
      path: ["body"],
    },
    {
      id: "explicit_urgency",
      is: "`value.body` が明確に緊急性を伝えている",
      uncertainMessage: "緊急性の判断ができません。人が確認してください。",
      message: "緊急とは判定できませんでした。",
      path: ["body"],
      // 判断が割れやすい条件は閾値を下げて「合格」に寄せる
      threshold: 0.8,
    },
  ],
  { context: { policy: "重複請求は返金対象。緊急対応は決済失敗の連続報告のみ。" } },
);

const input = {
  subject: "二重請求",
  body: "A-104 の注文で二重に請求されています。重複分を返金してください。",
};

const result = await Ticket.safeParseAsync(input);

if (result.success) {
  console.log("OK:", result.data);
} else {
  console.log("NG。意味検証の結果:");
  for (const issue of getSemanticIssues(result.error)) {
    console.log(`- ${issue.path.join(".") || "(root)"} ${issue.message}`, issue.details);
  }
}
