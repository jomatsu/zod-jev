# JEV 調査メモ

このライブラリ（zod-jev）の設計判断の根拠になる、TypeSafe JEV / System One API の調査結果です。
数値・仕様は **2026-09-17 時点** のもので、JEV は early access のため変更され得ます。

## 1. JEV とは

- TypeSafe AI の **System One モデル**第 1 弾。2026-09-15 に early access として公開。
- 「文章を生成しない」決定専用モデル。**unstructured state in → typed decisions out**。
- 会社: TypeSafe AI（サンフランシスコ）。共同創業者に元 OpenAI の Diogo Almeida、Erik Gafni、Sasha Sheng。DCVC リードで $40M 調達（発表記事・第三者報道より）。
- アーキテクチャ（会社の説明）:
  - **parallel sampler** — 自己回帰的にトークンを生成せず、事前に列挙した出力を並列にサンプリングする。これが速さの理由で、スキーマ不一致が原理的に起きない。
  - **RLCD（Reinforcement Learning for Calibrated Decisions）** — RLHF の代わりに「較正された確率」を訓練目標にする。
- 価格（発表時点）: input **$42 / 10 億トークン**、output は課金対象外。会社自身が「この価格は補助されている可能性があり、長期的には下がると見ている」と述べている。
- 位置づけ: LLM の置き換えではなく、**コード中の判定（if 文）の置き換え**。文章が必要な用途は LLM、判定は JEV、という分担が想定されている。

## 2. 3 つのプリミティブ

| プリミティブ | 何を聞くか | criteria の形 | 返る値 |
| --- | --- | --- | --- |
| `choice` | 定義済みの選択肢から 1 つ選ぶ | `{ label: 説明 }` のマップ | `choice`, `probabilities`, `confidence` |
| `score` | 順序づけられた段階で評価する | 説明の配列（順序が得点） | `score`（確率加重なので小数になり得る）, `legend`, `probabilities`, `confidence` |
| `noul` | はい / いいえ | `{ true, false }`（任意） | `noul` = P(はい) の 0〜1 |

- `noul` は **Bernoulli** の短縮。
- **`noul` には `confidence` が付かない**。`confidence` は Choice / Score の `probabilities` から計算される統計量で、`probabilities` があれば自前の尺度に置き換えてもよいと公式が明記している。
- 公式 API リファレンスは Score を「2 レベル以上」とだけ書いている。Rust クライアントの説明では Choice は最大 255 選択肢、Score は 2〜10 レベル。
- `instructions` と criteria の各値は **string / object / array / null** が使える（構造化してラベル付きの JSON を渡せる）。

## 3. HTTP API

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```jsonc
// request
{
  "state": { "message": "..." },        // string | object | array
  "model": "jev-latest",
  "questions": {
    "any_key": {
      "type": "noul",
      "instructions": "Does this convey urgency?",   // string | object | array | null
      "criteria": { "true": "...", "false": "..." }  // 任意
    }
  }
}
```

```jsonc
// response
{
  "model": "jev-latest",
  "answers": { "any_key": { "type": "noul", "noul": 0.92 } },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

| ステータス | 意味 |
| --- | --- |
| `401` | API キーが無い / 不正 |
| `422` | リクエストの形が不正（欠けているフィールド、壊れた質問など） |
| `429` | レート制限。バックオフして再試行する |
| `529` | TypeSafe 側が過負荷。バックオフして再試行する |

## 4. 設計に効く性質

1. **質問キーはモデルに送られない。** キーは質問と回答の突き合わせ専用で、推論には使われない。つまり各質問の `instructions` は**単体で意味が通る**必要がある。
2. **同じ state に対して並列・独立に評価される。** ある質問の答えを別の質問が見ることはできない。依存する判定が必要なら 2 回目のリクエストになる。
3. **質問を増やしてもレイテンシはほとんど変わらない。** 公式 cookbook では、13 問のブリーフィングを 1 リクエストにまとめると 12.2 倍安く 10.0 倍速く、答えは同じだったと報告されている。公式は「必要になるかもしれない質問も含めて投げ、使わない答えは捨てる」（**speculative fan-out**）を推奨している。
4. **予算は state と questions の共有。** 約 **32,000 トークン（≈150,000 文字）**。
5. **`confidence` は確信の集中度であって、正しさの証明ではない。** 公式の AI primer は「較正は予測の集団に対する性質で、個々の答えの正しさを保証しない」としている。閾値は自データで調整すべきもの。
6. **状態に書かれていることを聞く。** 公式は「`Is the bug reproducible from the text?`」が「読者がこの文だけで再現できるか」と解釈されて 0.36 になった例を挙げ、「`Does the reporter state that the problem occurs consistently?` のように、状態に書かれていることを聞け」としている。
7. **1 質問 1 判定。** 複数の観点が混ざった判定は分けて、コード側で重み付けして合成する（composite scoring）。
8. **Choice では no-match の選択肢（`other` / `unclear`）を必ず入れる。** モデルは与えられていない選択肢を選べない。

## 5. 公式 JavaScript SDK（`@typesafe-ai/sdk`）

このライブラリはトランスポートを SDK に委譲しています（再発明しないため）。

- バージョン 0.6.0 / MIT / Node.js 20 以上 / ESM + CJS / 実行時依存ゼロ。
- 環境変数: `TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`（既定 `https://api.typesafe.ai`）、`TYPESAFE_DEFAULT_MODEL`（既定 `jev-latest`）、`TYPESAFE_LOG_LEVEL`。
- リトライ既定: `maxRetries: 2`（初回を除く）、対象は `408` / `429` / `500-599`、`Retry-After` と `retry-after-ms` を尊重（上限 60 秒）、指数バックオフ 500ms → 5s、ジッター 0.25。
- タイムアウト既定: **10 秒（試行ごと**。全体の予算ではない）。
- **ブラウザでは起動を拒否する**（API キーが露出するため。`dangerouslyAllowBrowser` で解除は可能だが非推奨）。
- 応答本文は JSON パースするだけで**スキーマ検証をしない**。200 でも中身が違う可能性があるため、呼び出し側で形を確かめる必要がある。
- エラー型: `BadRequestError` / `AuthenticationError` / `PermissionDeniedError` / `NotFoundError` / `UnprocessableEntityError` / `RateLimitError`（`retryAfterMs` つき）/ `InternalServerError`、および `APIConnectionError` / `APITimeoutError` / `APIUserAbortError`。
- `language` は無関係。Python / Rust / Dart などの非公式・コミュニティ実装も存在する。

## 6. 実測（2026-09-17 / 応答の `model` は `jev-1.13.0`）

同じ state に対して複数の noul を 1 リクエストで投げた結果:

| 指示（`question`） | `noul` | input tokens |
| --- | --- | --- |
| "(en) asks for a refund or a reversal of a charge" | `0.99` | — |
| "(en) contains an email address or a phone number" | `0.02` | — |
| "(en) is urgent"（定義が曖昧） | `0.55` | — |
| "(en) is well written and grammatically correct"（主観的） | `0.94` | — |
| 4 問合計 | | `576` |
| "(ja) 返金や請求の取り消しを求めている" | `0.98` | — |
| "(ja) 氏名・メールアドレス・電話番号などの個人情報が含まれていない" | `0.02` | — |
| "(ja) 明確に緊急性を伝えている" | `0.30` | — |
| 3 問合計 | | `804` |

観察:

- 明確な yes / no は `0.98〜0.99` / `0.02` に張り付く。**日本語の指示でも同様に機能した**（指示の言語とメッセージの言語を分ける必要はない）。
- 曖昧・主観的な条件は `0.3〜0.94` に散る。**中間帯を「判断保留」として扱う設計は実データで意味を持つ**。
- 明確に成立している条件でも `0.90〜0.94` に落ち着くことがあるため、既定の閾値 `0.95` は fail-closed 側にかなり厳しい。
- レイテンシは 1 リクエストあたり 0.6〜0.9 秒（4〜6 問を含めて）。
- **応答の `model` はエイリアスではなく解決済みのモデル ID**（`jev-latest` ではなく `jev-1.13.0`）。リクエストにはエイリアスを使う。
- 4 問で input 576 トークン → 発表時点の価格で約 $0.000024。判定を増やしても輸出トークンは課金されない。

## 7. zod-jev の設計判断

| 判断 | 理由 |
| --- | --- |
| rules を **noul だけ**に変換する | 「条件が成立しているか」は yes/no に落ちる。分類や段階評価が本質なら素の SDK の Choice / Score を使うべきで、無理に yes/no で聞くと中間確率が量産される |
| 1 parse = **1 リクエスト**（全条件をまとめる） | 質問は並列・独立で、追加コストが小さい（speculative fan-out）。条件ごとに呼ぶと遅く高い |
| 配列は `semanticArray` で**自動分割** | `z.array(z.semantic(...))` は要素数ぶんリクエストが飛ぶ。JEV は 1 リクエストに多数の質問を載せられる |
| state を `{ value, context }` にする | 構造化 instructions で `` `value` `` / `` `context` `` を名前で指せる。公式の「フィールド名を明示する」指針に沿う |
| 既定 `criteria` に「曖昧・無情報は true でも false でもない」と書く | 判断保留を確率の端（0 / 1）に寄せないため。中間帯を潰さない |
| **対称な 2 つの閾値**（合格 `p >= t`、却下 `p <= 1-t`） | 確信のない否定を「却下」と呼ばない。`rejected` は「否定側が合格と同じ確信度で成立している」ときだけ |
| **fail-closed**（判定不能は issue） | 意味を確認できない入力を合格にしない。`unavailable` の理由コード（`timeout` / `network` / `http` / `malformed_response` / `not_json` / `state_too_large` / `unknown`）で後段が分岐できる |
| リトライで直らない 4xx は**既定で例外** | 401（キー）や 422（リクエスト不正）は設定・実装の誤りで、入力のエラーではない。早く大きく壊す |
| 呼び出し側の **abort は投げ直す** | キャンセルは制御フローであって検証結果ではない |
| 応答を Zod で**再検証**する | 公式 SDK は応答の形を検査しない。200 + 中身が違う応答を成功として扱わない |
| 32k トークン相当を**先に見る**（`maxStateCharacters`） | 予算の共有は API 側の制約。叩く前に落とすほうが安い |
| `base.pipe(stage)` ではなく **`base.superRefine(...)`** を使う | 返り値が base と同じ型の clone になり、`ZodObject` の `.extend()` や `z.toJSONSchema()`（output モード）がそのまま使える。pipe 版は output モードの JSON Schema 変換が `Custom types cannot be represented in JSON Schema` で落ち、構造化出力のヘルパーと併用できなかった。子の形式エラー時に refine が走らない性質も同じで、元の base は汚染されない |
| 例外本文・応答本文を**メッセージに載せない** | 利用者のデータや内部情報がログ・画面に出るのを避ける |

### 7.1 既存プロダクトへ入れるときの実測結果

2026-09-17 に確認した、実際の噛み合わせ:

| 項目 | 結果 |
| --- | --- |
| `result.data` の型・`.transform()` の結果 | 変わらない（`ZodSemantic<S> = S`） |
| `.safeExtend()` / `.strict()` / `.passthrough()` / `.catchall()` / `.required()` / `.optional()` / `.array()` | 使える（refine も引き継ぐ） |
| `.extend()` | zod 4.3〜4.5 では `Object schemas containing refinements cannot be extended. Use .safeExtend() instead.` で拒否。4.6 以降は使える |
| `z.toJSONSchema(schema)` / `{ io: "input" }` | どちらも base の形を返す |
| `.pick()` / `.omit()` / `.partial()` / `.merge()` | **Zod 4.3 以降は拒否する**（zod-jev 固有ではない）。4.0〜4.2 では**黙って refine を落とす**（検証が消える）ため peer を `zod@^4.3.0` にしている |
| 同期 `parse` / `safeParse` | 実行時に `Encountered Promise during synchronous parse` で落ちる。**型では検知できない** |
| 子の形式エラー時のリクエスト | 送られない |
| 兄弟フィールドに形式エラーがある場合 | その semantic フィールドの refine は走る（Zod は親の失敗を子に伝えない） |

## 8. 既知の限界

- JEV は early access。**価格・レート制限・既定モデルの解決先（`jev-latest` → `jev-1.13.0`）は変わり得る。**
- 較正は集団に対する性質で、単一の判定の正しさを保証しない。閾値は自分のデータで調整するもの。
- 「ハルシネーションゼロ」という宣伝は、**出力が事前定義された型に制約される**こと（型エラーが起きないこと）を指す。意味の正しさは確率で扱うしかない。
- 文章生成はできない。テキストが欲しい用途には LLM を使う。
- 32,000 トークンの共有予算、Choice の選択肢上限、Score のレベル数などの数値は 2026-09-17 時点の記述。
- API キーはサーバーに置く。公式 SDK もブラウザ実行を拒否する。

## 9. 出典

公式:

- [typesafe.ai](https://typesafe.ai/) — 製品概要、FAQ、価格
- [docs.typesafe.ai/introduction.md](https://docs.typesafe.ai/introduction.md) / [concepts/system-one.md](https://docs.typesafe.ai/concepts/system-one.md) — System One の位置づけ
- [docs.typesafe.ai/api.md](https://docs.typesafe.ai/api.md) — エンドポイント、リクエスト / レスポンス、エラー表
- [docs.typesafe.ai/primitives.md](https://docs.typesafe.ai/primitives.md) / [primitives/noul.md](https://docs.typesafe.ai/primitives/noul.md) / [primitives/choice.md](https://docs.typesafe.ai/primitives/choice.md) / [primitives/score.md](https://docs.typesafe.ai/primitives/score.md)
- [docs.typesafe.ai/primitives/advanced.md](https://docs.typesafe.ai/primitives/advanced.md) — 構造化 instructions / criteria
- [docs.typesafe.ai/confidence.md](https://docs.typesafe.ai/confidence.md) — confidence と閾値の考え方
- [docs.typesafe.ai/concepts/state.md](https://docs.typesafe.ai/concepts/state.md) — state の作り方
- [docs.typesafe.ai/patterns/fan-out.md](https://docs.typesafe.ai/patterns/fan-out.md) / [patterns/confidence-routing.md](https://docs.typesafe.ai/patterns/confidence-routing.md) — 投機的ファンアウトと確信度ゲート
- [docs.typesafe.ai/cookbooks/parallel_questions.md](https://docs.typesafe.ai/cookbooks/parallel_questions.md) — 1 リクエストにまとめたときの比較
- [docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt) — ドキュメント一覧（`.md` を付けると Markdown で取得できる）
- [github.com/typesafe-ai/typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js) / [npm: @typesafe-ai/sdk](https://www.npmjs.com/package/@typesafe-ai/sdk) — リトライ・タイムアウト・エラー分類の実装
- [status.typesafe.ai](https://status.typesafe.ai/) — 稼働状況

第三者:

- Developers Digest「TypeSafe Jev: the First Decision-Only Model Class, Benchmarked and Priced」 — 価格・RLCD の解説
- julin.ai「Jev: State In, Typed Decisions Out」 — 3 プリミティブの整理と RLCD への懐疑
- docs.rs `typesafe-client` / `typesafe_ai` — Rust クライアントの記述（Choice 255 選択肢、Score 2〜10 レベル、32,000 トークン）
- saascity.io / toolbit.ai / AI Wiki など 2026-09-15〜16 の報道 — 資金調達と創業者

> 実 API の挙動（`docs.typesafe.ai/api.md` と公式 SDK の実装）を一次情報として扱い、それ以外は出典つきの参考情報として記載しています。
