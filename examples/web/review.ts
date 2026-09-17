/**
 * 「普通のフォーム」の裏側で JEV が判定する例（ドメイン層）。
 *
 * 利用者に見えるのは普通のレビュー投稿フォームと普通のエラーだけです。
 * JEV の存在や確率は利用者には見せません（運用画面 /ops だけが知っています）。
 *
 * 写像（ここがアプリ側のポリシー）:
 *   rejected              → 入力エラーとして直してもらう（インライン表示）
 *   uncertain/unavailable → 受け付けて「審査中」にする（可用性優先・記録は残す）
 *   合格                   → 「掲載待ち」
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as Z from "zod";
import {
  createJevZod,
  getSemanticIssues,
  type JevJson,
  type JevResponseInfo,
  type SemanticIssue,
  type SemanticRule,
} from "../../src/index.js";

// --- 形（利用者に見せるエラー文言もここで持つ） ------------------------------
export const ReviewShape = Z.object({
  nickname: Z.string().trim().min(1, "ニックネームを入力してください").max(20, "ニックネームは20文字以内です"),
  rating: Z.coerce.number().int().min(1, "評価を選んでください").max(5, "評価は5段階です"),
  title: Z.string().trim().min(1, "タイトルを入力してください").max(60, "タイトルは60文字以内です"),
  body: Z.string().trim().min(10, "レビュー本文は10文字以上で入力してください").max(2000, "レビュー本文は2000文字以内です"),
  email: Z.union([Z.literal(""), Z.string().email("メールアドレスの形式が正しくありません")]).optional(),
});

export type Review = Z.output<typeof ReviewShape>;

// --- 意味（成立していてほしい条件） ------------------------------------------
export const ReviewRules: readonly SemanticRule[] = [
  {
    id: "no_personal_information",
    is: "`value.body` と `value.title` に、氏名・住所・電話番号・メールアドレス・注文番号など、個人を特定できる情報が含まれていない",
    message: "個人情報は入力しないでください。個別のご相談はお問い合わせフォームからお願いします。",
    path: ["body"],
    threshold: 0.9,
  },
  {
    id: "no_promotion",
    is: "`value.body` が、他社サービスへの誘導・宣伝・アフィリエイト目的のリンクや連絡先を含んでいない",
    message: "宣伝を目的とした投稿はできません。",
    path: ["body"],
    threshold: 0.9,
  },
  {
    id: "rating_matches_body",
    is: "`value.body` の内容が `value.rating` の評価と矛盾していない（`value.rating` は 1〜5 の整数で、5 が最も高評価）",
    message: "評価とコメントの内容が一致していません。星の数をご確認ください。",
    path: ["rating"],
    threshold: 0.9,
  },
  {
    id: "body_has_specifics",
    is: "`value.body` に、この商品を使った具体的な体験（使った場面、良かった点、気になった点など）が書かれている",
    uncertainMessage: "内容が具体的かどうかの判断がつきませんでした。",
    message: "具体的な使用感を書いていただけると、他の方の参考になります。",
    path: ["body"],
    threshold: 0.85,
  },
];

/** JEV に渡す参考情報。条件そのものではなく、判断の前提になる資料。 */
export const ReviewContext: JevJson = {
  guidelines: [
    "個人情報（氏名・連絡先・住所・注文番号）が書かれたレビューは、本人の同意なく掲載できない。入力し直してもらう。",
    "他社サービスへの誘導や宣伝リンクを含む投稿は掲載しない。",
    "評価（星）と本文の内容が食い違う場合は星の選び間違いの可能性が高いので、確認してもらう。",
    "文章が短く、具体的な体験が読み取れない場合は、掲載前に人が確認する。",
  ],
};

export type ReviewMode = "off" | "shadow" | "enforce";
export type ReviewStatus = "pending" | "review" | "rejected" | "invalid";

/** 運用画面（/ops）で見える 1 件分の記録。 */
export interface Submission {
  readonly id: string;
  readonly at: string;
  readonly mode: ReviewMode;
  readonly status: ReviewStatus;
  readonly review: Review;
  readonly issues: readonly SemanticIssue[];
  readonly jev: {
    readonly model: string | null;
    readonly latencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly questionCount: number;
    /** 実際に送った中身（デモ用。本番でこの全量を残さないこと） */
    readonly state: unknown;
    readonly questions: unknown;
    readonly answers: unknown;
  };
}

export type SubmitResult =
  | { readonly ok: true; readonly id: string; readonly status: "pending" | "review" }
  | {
      readonly ok: false;
      /** フィールドごとのエラー（普通のフォームのインライン表示に使う） */
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
      /** フィールドに紐づかないエラー */
      readonly formErrors: readonly string[];
    };

export interface ReviewServiceDeps {
  readonly mode: ReviewMode;
  readonly apiKey?: string;
  /** テストや --fake で差し替える fetch（省略時はグローバル fetch） */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly limit?: number;
}

interface Capture {
  request: { state?: unknown; questions?: unknown } | null;
  response: { model?: string; answers?: unknown } | null;
  metrics: JevResponseInfo | null;
}

/** フォームの裏側の処理。HTTP からもテストからも同じ経路で呼べる。 */
export function createReviewService(deps: ReviewServiceDeps) {
  const submissions: Submission[] = [];
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? 100;
  let sequence = 0;
  const nextId = deps.nextId ?? (() => `RV-${Date.now().toString(36).toUpperCase()}-${++sequence}`);

  // 送受信の記録は、リクエストごとの非同期コンテキストに閉じ込める（デモの表示用）。
  const captures = new AsyncLocalStorage<Capture>();
  const underlying =
    deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));

  const capturingFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const capture = captures.getStore();
    if (capture !== undefined && typeof init?.body === "string") {
      capture.request = JSON.parse(init.body) as Capture["request"];
    }
    const response = await underlying(input, init);
    if (capture !== undefined) {
      capture.response = (await response
        .clone()
        .json()
        .catch(() => null)) as Capture["response"];
    }
    return response;
  };

  // 形と意味は 1 か所で組み立てる。mode: off（キルスイッチ）では JEV のクライアントを作らない。
  const semantic =
    deps.mode === "off"
      ? undefined
      : createJevZod({
          apiKey: deps.apiKey,
          fetch: capturingFetch,
          onResponse: (info) => {
            const capture = captures.getStore();
            if (capture !== undefined) capture.metrics = info;
          },
        }).semantic(ReviewShape, ReviewRules, {
          context: ReviewContext,
          // 空のメールは state に載せない（無駄なトークンを使わない）
          toJSON: (review) => ({
            nickname: review.nickname,
            rating: review.rating,
            title: review.title,
            body: review.body,
            ...(review.email ? { email: review.email } : {}),
          }),
        });

  function store(submission: Submission): Submission {
    submissions.unshift(submission);
    if (submissions.length > limit) submissions.pop();
    return submission;
  }

  function buildRecord(
    status: ReviewStatus,
    review: Review,
    issues: readonly SemanticIssue[],
    capture: Capture,
    id: string,
  ): Submission {
    return {
      id,
      at: now().toISOString(),
      mode: deps.mode,
      status,
      review,
      issues,
      jev: {
        model: capture.metrics?.model || capture.response?.model || null,
        latencyMs: capture.metrics?.latencyMs ?? 0,
        inputTokens: capture.metrics?.inputTokens ?? 0,
        outputTokens: capture.metrics?.outputTokens ?? 0,
        questionCount: capture.metrics?.questionCount ?? 0,
        state: capture.request?.state ?? null,
        questions: capture.request?.questions ?? null,
        answers: capture.response?.answers ?? null,
      },
    };
  }

  return {
    async submit(raw: unknown): Promise<SubmitResult> {
      // (1) 形: 同期。ここで落ちる入力では JEV を呼ばない。
      const shape = ReviewShape.safeParse(raw);
      if (!shape.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of shape.error.issues) {
          const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
          (fieldErrors[field] ??= []).push(issue.message);
        }
        return { ok: false, fieldErrors, formErrors: [] };
      }

      const review = shape.data;
      const capture: Capture = { request: null, response: null, metrics: null };

      // (2) 意味: 非同期。条件は 1 リクエストにまとめて送る。
      let issues: readonly SemanticIssue[] = [];
      if (semantic !== undefined) {
        await captures.run(capture, async () => {
          const result = await semantic.safeParseAsync(raw);
          if (!result.success) issues = getSemanticIssues(result.error);
        });
      }

      // (3) プロダクト状態への写像（ここがチームのポリシー）
      const rejected = issues.filter((issue) => issue.details.kind === "rejected");
      const id = nextId();

      if (deps.mode === "enforce" && rejected.length > 0) {
        const fieldErrors: Record<string, string[]> = {};
        const formErrors: string[] = [];
        for (const issue of rejected) {
          const field = typeof issue.path[0] === "string" ? issue.path[0] : undefined;
          if (field === undefined) formErrors.push(issue.message);
          else (fieldErrors[field] ??= []).push(issue.message);
        }
        // 差し戻した入力も運用画面には残す（どんな投稿が弾かれたかを見るため）
        store(buildRecord("rejected", review, issues, capture, id));
        return { ok: false, fieldErrors, formErrors };
      }

      // uncertain / unavailable は受け付けて「審査中」。shadow / off は記録だけで「掲載待ち」。
      const status: "pending" | "review" =
        deps.mode === "enforce" && issues.length > 0 ? "review" : "pending";
      store(buildRecord(status, review, issues, capture, id));
      return { ok: true, id, status };
    },

    /** 運用画面用。新しい順。 */
    list(): readonly Submission[] {
      return submissions;
    },
  };
}
