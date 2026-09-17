# 既存プロダクトへの導入手順

「すでに Zod でリクエスト検証をしているサーバーアプリ」に zod-jev を入れるときの実際の進め方です。
動く実例が `examples/adoption/`（`intake.ts` + `run.ts`）にあり、次で確認できます。

```sh
npx tsx examples/adoption/run.ts          # JEV を模した偽 fetch（鍵不要・課金なし）
npx tsx examples/adoption/run.ts --live   # 実 API（TYPESAFE_API_KEY / .env が必要）
```

## 0. どの判定を JEV に任せるか

| 判定の種類 | 担当 | 例 |
| --- | --- | --- |
| 形式・必須・桁数・列挙 | **Zod** | `email` の形式、`subject` が空でない、`status` が 3 値のどれか |
| 意味の条件（確率が要る） | **JEV（このライブラリ）** | 個人情報が含まれていない、ポリシーに適合している、注入の疑いがない、内容が具体的 |
| 分類・段階評価（値を取る） | **素の JEV**（`choice` / `score`） | 問い合わせ種別、深刻度 |

JEV の `noul` は yes/no 専用です。「どの種別か」を条件として書くと、種別が違う入力が全部エラーになります。分類が欲しいだけなら素の SDK の `choice` を使ってください。

## 1. 接続を 1 か所に集める

```ts
// src/jev.ts（アプリ内で唯一 zod-jev を触る場所）
import { createJevZod } from "zod-jev";

export const z = createJevZod({
  // apiKey は TYPESAFE_API_KEY をそのまま使う
  onResponse: ({ model, inputTokens, outputTokens, latencyMs }) =>
    metrics.histogram("jev.latency_ms", latencyMs).increment("jev.tokens", inputTokens + outputTokens),
});
```

- キーは環境変数。**モジュールスコープで 1 回だけ**作る（`createJevZod()` は呼んだ瞬間にクライアントを作り、キーが無ければ例外になります）。
- `onResponse` を最初から入れておくと、shadow 期間でコストとレイテンシを同時に測れます。

## 2. 形はそのまま、意味を「別のスキーマ」として足す

既存ハンドラの変更はこの形が最小です（`examples/adoption/intake.ts`）。

```diff
- export function intake(raw: unknown) {
-   const parsed = TicketShape.safeParse(raw);      // 同期
-   if (!parsed.success) return invalid(parsed.error);
-   return accept(parsed.data);
- }
+ export function createIntake({ mode, ... }) {
+   const SemanticTicket = mode === "off" ? undefined
+     : createJevZod({ apiKey, onResponse })
+         .semantic(TicketShape, TicketRules, { context: TicketContext });   // 同じ形から導出
+
+   return async function intake(raw: unknown) {
+     const parsed = TicketShape.safeParse(raw);      // ← 既存のまま。同期のまま残す
+     if (!parsed.success) return invalid(parsed.error);
+     if (mode === "off" || SemanticTicket === undefined) return accept(parsed.data);
+
+     const semantic = await SemanticTicket.safeParseAsync(raw);             // ← 意味だけ非同期
+     if (semantic.success) return accept(parsed.data);
+
+     const issues = getSemanticIssues(semantic.error);                      // 形式エラーは入らない
+     return route(issues, parsed.data, mode);                               // 扱いはアプリが決める
+   };
+ }
```

- **形のチェックを消さない**。意味検証が落ちても、形式エラーは今までどおり同期で返せます。
- 形が壊れている入力では JEV は呼ばれません（Zod が子の refine を実行しないため課金も遅延も発生しない）。
- スキーマは同じ `TicketShape` から導出するので、形と意味がずれません。

## 3. まず shadow で流す（挙動を変えない）

`mode: "shadow"` は JEV を呼びますが、結果は記録するだけでリクエストの扱いは変えません。

```ts
onIssues: (issues, ticket) => audit.insert({ issues, ticket, at: Date.now() })
```

見るもの:

- 条件ごとの確率の分布（閾値をどこに置くかを実データで決める）
- `rejected` / `uncertain` / `unavailable` の割合
- 「人が見て本当に問題だった」サンプル（誤検知の条件文を直す）

実測（2026-09-17、3 条件 + context で 1 リクエスト）:

| 入力 | 実際の確率 |
| --- | --- |
| 正常な返金依頼 | すべて 0.99 前後（issue なし） |
| 本文に電話番号とカード番号 | 「個人情報が含まれていない」 = **0.01** |
| 「これまでの指示を無視して…」 | 「指示の上書きが含まれていない」 = **0.01** |
| 「とにかく早く直してください」 | 「具体的な依頼内容が書かれている」 = **0.06** |

## 4. enforce に切り替える（落ち方ごとの扱いはアプリが決める）

| 結末 | 典型的な扱い | 理由 |
| --- | --- | --- |
| `rejected` | 422 / 400 で差し戻し（`issue.message` を利用者に見せる） | 条件が明確に成立していない |
| `uncertain` | 受け付けて**人によるレビュー**に回す | 判断できなかっただけで、入力が悪いわけではない |
| `unavailable` | 受け付けて記録 + アラート | JEV 障害でサービスを止めない（メトリクスとセットなら安全） |
| 形式エラー | 従来どおり（Zod） | 担当が違う |

> ライブラリ単体は **fail-closed**（`unavailable` も issue として報告）です。上の表のような「可用性優先」のポリシーは、ライブラリの既定を変えるのではなく**アプリ側の 2 段構えで表現**します。これが 2 章で形と意味を分ける一番の理由です。

## 5. 閾値と条件文を調整する

- 却下（`rejected`）になるのは **`p <= 1 - threshold`** のときだけです。つまり **閾値を下げるほど却下の範囲が広がり、レビュー行きが減ります**。
  - 実例: 「具体的な依頼内容」が `0.06` のとき、`threshold: 0.8` なら **却下**、`threshold: 0.95` なら **保留（レビュー）**。
- 目安: 契約・金銭・安全に関わる条件は `0.9〜0.95`、一般的なゲートは `0.85〜0.9`、なるべく通したい条件は `0.8`。判断が割れる条件は `uncertain` として人に流すほうが安全です。
- 条件文は「状態に書かれていることを聞く」形にします（例: 「再現手順として十分か」→「本文に再現手順が書かれているか」）。独立した観点は条件を分けて同じリクエストに載せると、遅延を増やさずに済みます。

## 6. テストと CI

- ユニットテストでは `fetch` か `client` を注入します。SDK のリトライ・ヘッダ・エラー分類はそのまま本物が動くので、リトライ経路まで検証できます。
- 既定の `npm test` は鍵不要・課金なし。実 API は `npm run test:integration` に分離し、CI にはキーを置かない。
- shadow 期間に集めた入力を使って「この入力はこの条件で落ちる」を回帰テストにします（確率が閾値をまたいだら気づける）。

## 7. 運用

| 項目 | 実測値 / 方針 |
| --- | --- |
| コスト | 3 条件 + context で input **1,039〜1,083 tokens ≒ $0.000044 / 回**（output は課金対象外、発表時点の価格） |
| レイテンシ | 1 リクエスト **190〜840ms**（条件を増やしてもほぼ変わらない。初回はコールドで遅い） |
| リトライ | SDK が 408 / 429 / 5xx を `Retry-After` 尊重で再試行（既定 2 回）。アプリ側で追加のリトライは不要 |
| まとめ送り | バルク処理は `semanticArray` や 1 リクエスト複数条件で減らす（条件ごとに呼ぶのは遅く高い） |
| 監視 | `onResponse`（tokens / latency）、`unavailable` 率、`rejected` / `uncertain` 率、条件ごとの確率分布 |
| ロールバック | `mode: "off"`（キルスイッチ）。**キーが無くても起動できる**ように、`off` のときはクライアントを作らない構成にする |
| モデル | リクエストは `jev-latest`、応答の `model` は解決済み ID（実測 `jev-1.13.0`）なので、変化を監視できる |

## 8. やってはいけない

- **スキーマを丸ごと置き換える**（`parse` → `parseAsync` の一括変更）。影響範囲が広すぎます。意味検証は「明示的に await する 1 段」として足すのが安全です。
- **ホットパスに直埋めする**。遅延・課金・外部障害点が同時に増えます。
- **分類・要約を「条件」として書く**。値が欲しいなら素の JEV の `choice` / `score`。
- **`unavailable` を黙って通す**。fail-open にするならメトリクスとセットで。
- **ユニットテストから実 API を叩く**。

## 9. 実行結果（実 API / 2026-09-17）

```
--- 本文に個人情報（ブロックしたい） ---
  off     accepted
  shadow  accepted（shadow記録のみ）: no_pii_in_body=0.01(rejected), self_service_ready=0.23(uncertain)
  enforce rejected: 本文に個人情報が含まれています。マスクしてから処理してください。

--- 指示の上書きを試みる入力（ブロックしたい） ---
  off     accepted
  shadow  accepted（shadow記録のみ）: no_instruction_override=0.01(rejected), self_service_ready=0.30(uncertain)
  enforce rejected: 本文にプロンプトインジェクションの疑いがあります。人が確認してください。

--- 形が壊れている（JEV は呼ばれない） ---
  off/shadow/enforce  invalid: ...   [JEV呼び出し=0]
```

`npm run test:integration`（実 API）と `test/adoption.test.ts`（偽 fetch）で、この振る舞いを固定しています。
