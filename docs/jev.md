# Jev 調査メモ

本ライブラリ（zod-jev）の設計判断の根拠となる、TypeSafe Jev / System One API の調査結果です。
記載している数値や仕様は **2026-09-17 時点** のものであり、Jev は early access であるため、今後変更される可能性があります。

## 1. Jev とは

- TypeSafe AI による **System One モデル**の第 1 弾です。2026-09-15 に early access として公開されました。
- 「文章を生成しない」決定専用モデルです。**unstructured state in → typed decisions out** を特徴とします。
- 会社: TypeSafe AI（サンフランシスコ）。共同創業者は元 OpenAI の Diogo Almeida、Erik Gafni、Sasha Sheng です。DCVC リードで $40M を調達しています（発表記事および第三者報道より）。
- アーキテクチャ（同社の説明）:
  - **parallel sampler** — 自己回帰的にトークンを生成せず、事前に列挙した出力を並列にサンプリングします。これが高速性の理由であり、スキーマ不一致が原理的に発生しません。
  - **RLCD（Reinforcement Learning for Calibrated Decisions）** — RLHF の代わりに「較正された確率」を訓練目標とします。
- 価格（発表時点）: input は **$42 / 10 億トークン**、output は課金対象外です。同社自身が「この価格は補助されている可能性があり、長期的には下がると見ている」と述べています。
- 位置づけ: LLM の置き換えではなく、**コード中の判定（if 文）の置き換え**です。文章が必要な用途には LLM を用い、判定には Jev を用いるという分担が想定されています。

## 2. 3 つのプリミティブ

| プリミティブ | 何を聞くか | criteria の形 | 返る値 |
| --- | --- | --- | --- |
| `choice` | 定義済みの選択肢から 1 つ選ぶ | `{ label: 説明 }` のマップ | `choice`, `probabilities`, `confidence` |
| `score` | 順序づけられた段階で評価する | 説明の配列（順序が得点） | `score`（確率加重なので小数になり得る）, `legend`, `probabilities`, `confidence` |
| `noul` | はい / いいえ | `{ true, false }`（任意） | `noul` = P(はい) の 0〜1 |

- `noul` は **Bernoulli** の短縮形です。
- **`noul` には `confidence` が付きません**。`confidence` は Choice / Score の `probabilities` から計算される統計量であり、`probabilities` があれば自前の尺度に置き換えてもよいと公式ドキュメントに明記されています。
- 公式 API リファレンスでは Score について「2 レベル以上」とだけ記載されています。一方、Rust クライアントの説明では Choice は最大 255 選択肢、Score は 2〜10 レベルとされています。
- `instructions` と criteria の各値には **string / object / array / null** が使用できます（構造化してラベル付きの JSON を渡せます）。

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

1. **質問キーはモデルに送られません。** キーは質問と回答の突き合わせ専用であり、推論には使われません。そのため、各質問の `instructions` は**単体で意味が通る**必要があります。
2. **同じ state に対して並列・独立に評価されます。** ある質問の答えを別の質問から参照することはできません。依存する判定が必要な場合は、2 回目のリクエストとして実行する必要があります。
3. **質問を増やしてもレイテンシはほとんど変わりません。** 公式 cookbook では、13 問のブリーフィングを 1 リクエストにまとめると 12.2 倍安く 10.0 倍速くなり、答えも同一であったと報告されています。公式ドキュメントでは「必要になるかもしれない質問も含めてまとめて送り、使わない答えは捨てる」（**speculative fan-out**）手法を推奨しています。
4. **予算は state と questions で共有されます。** 上限は約 **32,000 トークン（≈150,000 文字）** です。
5. **`confidence` は確信の集中度であって、正しさの証明ではありません。** 公式の AI primer では「較正は予測の集団に対する性質であり、個々の答えの正しさを保証するものではない」としています。閾値は実データに基づいて調整する必要があります。
6. **状態に書かれている事実を直接尋ねます。** 公式ドキュメントでは、「`Is the bug reproducible from the text?`」という質問が「読者がこの文だけで再現できるか」と解釈されて 0.36 に低下した事例を取り上げ、「`Does the reporter state that the problem occurs consistently?` のように、状態に書かれている事実を尋ねるべきである」としています。
7. **原則として 1 質問につき 1 判定とします。** 複数の観点が混ざった判定は個別に分割し、コード側で重み付けして合成します（composite scoring）。
8. **Choice では no-match の選択肢（`other` / `unclear`）を必ず含めます。** モデルはプロンプトで与えられていない選択肢を選ぶことはできません。

## 5. 公式 JavaScript SDK（`@typesafe-ai/sdk`）

本ライブラリは、車輪の再発明を避けるため、トランスポート処理を公式 SDK に委譲しています。

- バージョンは 0.6.0、ライセンスは MIT です。Node.js 20 以上に対応し、ESM と CJS の双方をサポートしています。実行時依存はありません（ゼロディペンデンシー）。
- 環境変数: `TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`（既定値: `https://api.typesafe.ai`）、`TYPESAFE_DEFAULT_MODEL`（既定値: `jev-latest`）、`TYPESAFE_LOG_LEVEL`。
- リトライの既定動作: `maxRetries: 2`（初回を除く）、対象は `408` / `429` / `500-599` です。`Retry-After` と `retry-after-ms` を尊重し（上限 60 秒）、指数バックオフ（500ms → 5s、ジッター 0.25）が適用されます。
- タイムアウトの既定値: **試行ごとに 10 秒** です（リクエスト全体の予算ではありません）。
- **ブラウザ環境での実行は既定で拒否されます**（API キーが露出するためです。`dangerouslyAllowBrowser` で解除は可能ですが、非推奨とされています）。
- 応答本文は JSON パースされるのみで、**スキーマ検証は行われません**。ステータスが 200 であっても中身が想定と異なる可能性があるため、呼び出し側でレスポンスの構造を確かめる必要があります。
- 定義されているエラー型: `BadRequestError` / `AuthenticationError` / `PermissionDeniedError` / `NotFoundError` / `UnprocessableEntityError` / `RateLimitError`（`retryAfterMs` 付き）/ `InternalServerError`、および `APIConnectionError` / `APITimeoutError` / `APIUserAbortError` です。
- `language` は無関係です。Python / Rust / Dart などの非公式・コミュニティ実装も存在します。

## 6. 実測（2026-09-17 / 応答の `model` は `jev-1.13.0`）

同じ state に対して複数の noul を 1 つのリクエストで送信した結果は次のとおりです。

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

- 明確な yes / no は `0.98〜0.99` / `0.02` に収束します。**日本語の指示でも同様に機能しました**（指示の言語とメッセージの言語を分ける必要はありません）。
- 曖昧・主観的な条件は `0.3〜0.94` に分散します。**中間帯を「判断保留」として扱う設計方針は、実際のデータにおいても有効です**。
- 明確に成立している条件であっても `0.90〜0.94` に落ち着くことがあるため、既定の閾値 `0.95` は fail-closed 側にかなり厳しい設定です。
- レイテンシは 1 リクエストあたり 0.6〜0.9 秒でした（4〜6 問を含めた場合）。
- **応答の `model` はエイリアスではなく解決済みのモデル ID です**（`jev-latest` ではなく `jev-1.13.0`）。リクエストにはエイリアスを使用します。
- 4 問で input は 576 トークンとなり、発表時点の価格で約 $0.000024 です。判定を増やしても出力トークンは課金されません。

## 7. zod-jev の設計判断

| 判断 | 理由 |
| --- | --- |
| rules を **noul だけ**に変換する | 「条件が成立しているか」は yes/no に落ちる。分類や段階評価が本質なら素の SDK の Choice / Score を使うべきで、無理に yes/no で聞くと中間確率が量産される |
| 1 parse = **1 リクエスト**（全条件をまとめる） | 質問は並列・独立で、追加コストが小さい（speculative fan-out）。条件ごとに呼ぶと遅く高い |
| 配列は `semanticArray` で**自動分割** | `z.array(z.semantic(...))` は要素数ぶんリクエストが飛ぶ。Jev は 1 リクエストに多数の質問を載せられる |
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

2026-09-17 に確認した、実際の動作検証結果です。

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

- Jev は early access です。**価格・レート制限・既定モデルの解決先（`jev-latest` → `jev-1.13.0`）は今後変更される可能性があります。**
- 較正は集団に対する性質であり、単一の判定の正しさを保証するものではありません。閾値は自身のデータで調整する必要があります。
- 「ハルシネーションゼロ」という宣伝は、**出力が事前定義された型に制約されること**（型エラーが起きないこと）を指します。意味的な正しさは確率として扱う必要があります。
- 文章生成はできません。テキストが必要な用途には LLM を使用します。
- 32,000 トークンの共有予算、Choice の選択肢上限、Score のレベル数などの数値は、2026-09-17 時点の記述に基づいています。
- API キーはサーバー側に配置します。公式 SDK においてもブラウザ環境での実行は拒否されます。

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
- [docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt) — ドキュメント一覧（`.md` を付けると Markdown で取得できます）
- [github.com/typesafe-ai/typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js) / [npm: @typesafe-ai/sdk](https://www.npmjs.com/package/@typesafe-ai/sdk) — リトライ・タイムアウト・エラー分類の実装
- [status.typesafe.ai](https://status.typesafe.ai/) — 稼働状況

第三者:

- Developers Digest「TypeSafe Jev: the First Decision-Only Model Class, Benchmarked and Priced」 — 価格・RLCD の解説
- julin.ai「Jev: State In, Typed Decisions Out」 — 3 プリミティブの整理と RLCD への懐疑
- docs.rs `typesafe-client` / `typesafe_ai` — Rust クライアントの記述（Choice 255 選択肢、Score 2〜10 レベル、32,000 トークン）
- saascity.io / toolbit.ai / AI Wiki など 2026-09-15〜16 の報道 — 資金調達と創業者

> 実 API の挙動（`docs.typesafe.ai/api.md` と公式 SDK の実装）を一次情報として扱い、それ以外は出典つきの参考情報として記載しています。
