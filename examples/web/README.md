# デモ web アプリ（普通の出品画面 + 裏で JEV）

**利用者向けのページは、ごく普通のフリマアプリの出品画面です。** JEV の存在・確率・条件 ID は一切出しません。
出品ボタンの裏で Zod が「形」を、TypeSafe JEV が「意味」を判定し、その結果を普通のプロダクト状態に写像します。

| 画面 | 役割 |
| --- | --- |
| `/` | 出品画面（利用者向け）。写真・カテゴリー・状態・配送料・手数料計算まで、よくある形 |
| `/ops` | 判定の裏側（開発者向け）。条件ごとの確率・閾値・送信内容・トークンが見える |

公開: **https://zod-jev.jomatsu.me/**（`/ops` は開発者向け）

```sh
# ローカルの Node サーバー（実 API）
npm run demo:web

# 偽の判定で試す（鍵不要・課金なし）
npm run demo:web:fake

# Cloudflare Workers としてローカル実行（.dev.vars にキーを置く）
npm run dev:web        # → http://localhost:8788

# デプロイ / Secret の登録
npm run deploy:web
npx wrangler secret put TYPESAFE_API_KEY --config examples/web/wrangler.jsonc
```

## 裏側の流れ

```
「出品する」が押される
  │
  ├─ (1) Zod: 形（必須・文字数・価格の範囲・選択肢）     同期。ここで落ちたら JEV は呼ばない
  │
  ├─ (2) JEV: 意味（6 条件を 1 リクエストにまとめて送る）  非同期・実測 0.2〜0.5 秒
  │        no_prohibited_items / no_contact_or_external / category_matches_item /
  │        condition_matches_description / price_is_plausible / description_is_sufficient
  │
  └─ (3) プロダクト状態への写像（アプリ側のポリシー）
           rejected              → 出品不可。理由を該当項目の下に出す（インライン）
           uncertain/unavailable → 受け付けて「審査中」（利用者には普通の案内文だけ）
           合格                   → 「出品が完了しました」（公開中）
```

利用者に見えるもの / 見えないもの:

| | 利用者（`/`） | 開発者（`/ops`） |
| --- | --- | --- |
| 形式エラー | 「商品名を入力してください」 | 同左 |
| 意味の違反 | 「連絡先や外部サイトの記載はできません」（普通のエラー） | どの条件が何 % で落ちたか、閾値つきで見える |
| 判断できなかった | **何も見えない**（「審査が終わり次第公開されます」だけ） | `uncertain` / `unavailable` と確率が見える |
| JEV の送受信内容 | 見えない | `state` / `questions` / `answers` / トークン / レイテンシ |

## 判定に使っている条件

| 条件 ID | 成立していてほしいこと | 閾値 |
| --- | --- | --- |
| `no_prohibited_items` | 出品禁止物（医薬品、模倣品、金券、生き物、武器、他人の個人情報…）を示していない | 0.90 |
| `no_contact_or_external` | 説明に電話番号・メール・SNS ID・外部 URL が含まれていない | 0.90 |
| `category_matches_item` | 選択カテゴリーが商品名と説明の内容と一致している | 0.90 |
| `condition_matches_description` | 選択した「商品の状態」が説明の記載と矛盾していない | 0.85 |
| `price_is_plausible` | 価格が内容に対して極端に相場から外れていない（`context.price_guide` を参照） | 0.90 |
| `description_is_sufficient` | 状態・型番・付属品など、購入判断に必要な情報が書かれている | 0.65 |

## 実測（2026-09-17 / `jev-1.13.0`）

| 出品 | HTTP | 結果 | 実際の確率 |
| --- | --- | --- | --- |
| 良い出品（カメラ、説明が具体的） | 201 | 公開中 | issue なし（`tokens=2030`, 448ms） |
| 説明に電話番号とメール | 422 | 出品不可 | `no_contact_or_external=0.02` |
| 市販薬のまとめ売り | 422 | 出品不可 | `no_prohibited_items=0.02`, `description_is_sufficient=0.30` |
| 「カメラです。よろしくお願いします。」 | 422 | 出品不可 | `description_is_sufficient=0.05` |
| 傷だらけなのに「目立った傷や汚れなし」 | 422 | 出品不可 | `condition_matches_description=0.05` |

1 出品あたり input 約 1,900〜2,050 tokens（6 条件 + 出品ガイドライン + 相場の目安）＝ **約 $0.00008**、
レイテンシ 160〜470ms。条件を増やしても 1 リクエストなので時間はほとんど変わらない。

閾値も実測で調整している（コードにコメントを残している）:

- `description_is_sufficient`: 詳しい説明が 0.9 以上、短い説明が 0.1 以下だったので 0.85 → **0.65**
- `condition_matches_description`: 説明に傷の言及があると、状態と矛盾していなくても 0.86 程度まで下がることがあったので 0.90 → **0.85**

## 構成

| ファイル | 役割 |
| --- | --- |
| `listing.ts` | ドメイン層。スキーマ・6 条件・プロダクト状態への写像・記録（HTTP からもテストからも同じ経路） |
| `server.ts` | ローカル用の `node:http` サーバー（`--fake` / `--mode=off\|shadow` 対応） |
| `worker.ts` | Cloudflare Workers 版。静的は Workers Assets、記録は Durable Object |
| `wrangler.jsonc` | Workers の設定（nodejs_compat / Assets / Durable Object / カスタムドメイン） |
| `fake.ts` | `--fake` 用の偽 JEV と、`/ops` のデモ用サンプル出品 |
| `public/` | 画面（フレームワークなし）。`index.html`+`app.js` が出品画面、`ops.html`+`ops.js` が裏側 |

## 設計上のポイント

- **API キーはサーバー側にだけ置く。** 公式 SDK もブラウザ実行を拒否するため、JEV の呼び出しは必ずサーバーで行います。
- **利用者に AI を見せない。** 判定結果は「公開中 / 審査中 / 出品不可」という普通の状態に写像し、文言も普通のフォームのものにしています。
- **`uncertain` をエラーにしない。** 判断できなかっただけで入力が悪いわけではないので、受け付けて「審査中」にします（可用性優先）。この判断がアプリ側にあることが、ライブラリを 2 段構えで使う理由です。
- **写真は state に載せない**（`SemanticOptions.toJSON`）。判定に不要な情報を送らずに済みます。
- **初期表示は「前回の下書き」** として用意しています（実際のアプリでも下書きは保存される）。`下書きを復元 / クリア` から切り替えられます。
- 送受信の記録はリクエストごとの非同期コンテキスト（`AsyncLocalStorage`）に閉じ込めています。デモで中身を見せるための仕掛けで、本番では `onResponse` でメトリクスを送るだけにして、利用者の入力を全量保存しないでください。
- `--fake` は入力の特徴から確率を決めるだけの偽物です。UI と分岐の確認用で、JEV の精度とは関係ありません。

## Cloudflare Workers 固有のメモ（実測で踏んだこと）

- **受付記録は isolate ごとのメモリに置いてはいけない。** 最初はモジュールスコープの配列で保持していたが、3 件出品しても `/ops` に 1 件しか見えないことがあった（リクエストが別の isolate に当たるため）。Durable Object に永続化して直した。
- `durable_objects` のバインディングは**名前空間**であり、`.fetch` は直接呼べない。`get(idFromName("listings"))` でスタブを取る（RPC を使わず HTTP のまま）。
- ローカルの `wrangler dev` では Secret が使われないので、`examples/web/.dev.vars` に `TYPESAFE_API_KEY` を置く（gitignore 済み）。
- キー無しでもデプロイできるよう、`REVIEW_MODE=off` のときは JEV のクライアントを作らない（キルスイッチ）。`FAKE_JEV=1` なら偽の判定で課金なしに確認できる。

> 記録には利用者の入力を含む（`state` / `questions` / `answers`）。デモとして見せるための全量保存なので、本番では保持項目を絞るか、`onResponse` のメトリクスだけにする。

## 制限

- 画像アップロードは見た目だけです（判定にも使いません）。認証・DB・検索・購入フローはありません。
- 記録は最大 100 件（`limit` / `STORE_LIMIT`）。Node サーバー版は再起動で消え、Workers 版は Durable Object に残ります。
- `/ops` には認証がありません（公開デモのため）。本番では必ず保護してください。
