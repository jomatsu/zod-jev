/**
 * 「普通の toC 画面」の裏側で JEV が判定する例（ドメイン層）: フリマアプリの出品。
 *
 * 利用者に見えるのは出品フォームと、普通の結果表示だけ:
 *   「出品が完了しました」 / 「審査中です」 / 「出品できません（理由は該当項目の下）」
 * 確率・条件 ID・閾値は利用者には見せない（/ops だけが知っている）。
 *
 * 写像（ここがアプリ側のポリシー）:
 *   rejected              → 出品不可。理由を該当フィールドの下に出す
 *   uncertain/unavailable → 受け付けて「審査中」（可用性優先。実際のフリマでもあり得る挙動）
 *   合格                   → 出品完了（公開中）
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

export const CATEGORIES = [
  "レディース",
  "メンズ",
  "ベビー・キッズ",
  "家電・スマホ・カメラ",
  "おもちゃ・ホビー・グッズ",
  "コスメ・美容",
  "本・音楽・ゲーム",
  "スポーツ・レジャー",
  "その他",
] as const;

export const CONDITIONS = [
  "新品、未使用",
  "未使用に近い",
  "目立った傷や汚れなし",
  "やや傷や汚れあり",
  "傷や汚れあり",
  "全体的に状態が悪い",
] as const;

export const SHIPPING_FEES = ["送料込み（出品者負担）", "着払い（購入者負担）"] as const;
export const SHIPPING_DAYS = ["1〜2日で発送", "2〜3日で発送", "4〜7日で発送"] as const;

/** 販売手数料（フリマアプリの一般的な料率）。 */
export const FEE_RATE = 0.1;

// --- 形（利用者に見せるエラー文言もここで持つ） ------------------------------
export const ListingShape = Z.object({
  title: Z.string().trim().min(1, "商品名を入力してください").max(40, "商品名は40文字以内で入力してください"),
  body: Z.string().trim().min(10, "商品の説明は10文字以上で入力してください").max(1000, "商品の説明は1000文字以内で入力してください"),
  category: Z.enum(CATEGORIES, "カテゴリーを選択してください"),
  condition: Z.enum(CONDITIONS, "商品の状態を選択してください"),
  shippingFee: Z.enum(SHIPPING_FEES, "配送料の負担を選択してください"),
  shippingDays: Z.enum(SHIPPING_DAYS, "発送までの日数を選択してください"),
  price: Z.coerce
    .number({ message: "価格は数字で入力してください" })
    .int("価格は整数で入力してください")
    .min(300, "価格は300円以上で入力してください")
    .max(9_999_999, "価格は9,999,999円以下で入力してください"),
});

export type Listing = Z.output<typeof ListingShape>;

/** 販売手数料と振込金額（画面の価格欄の下に出す）。 */
export const fees = (price: number) => {
  const fee = Math.floor(price * FEE_RATE);
  return { fee, payout: price - fee };
};

// --- 意味（成立していてほしい条件） ------------------------------------------
export const ListingRules: readonly SemanticRule[] = [
  {
    id: "no_prohibited_items",
    is: "`value.title` と `value.body` が、出品が禁止されている物（医薬品・市販薬・医療機器、模倣品やコピー品、現金・ギフトカードの番号、アカウントや権利の譲渡、生き物、武器、危険物、他人の個人情報が載った書類など）を示していない",
    message: "出品できない商品が含まれています。出品ガイドラインをご確認ください。",
    path: ["body"],
    threshold: 0.9,
  },
  {
    id: "no_contact_or_external",
    is: "`value.body` に、電話番号・メールアドレス・SNS の ID・外部サイトの URL など、取引以外の連絡手段や外部への誘導が含まれていない",
    message: "連絡先や外部サイトの記載はできません。お取引は取引メッセージでお願いします。",
    path: ["body"],
    threshold: 0.9,
  },
  {
    id: "category_matches_item",
    is: "`value.category`（選択されたカテゴリー）が `value.title` と `value.body` の内容と一致している",
    message: "カテゴリーが商品の内容と一致していません。選び直してください。",
    path: ["category"],
    threshold: 0.9,
  },
  {
    id: "condition_matches_description",
    is: "`value.condition`（選択された商品の状態）が `value.body` の記載と矛盾していない（傷、汚れ、使用期間、付属品の有無などを比べて）",
    message: "商品の状態と説明の内容が一致していません。状態を選び直してください。",
    path: ["condition"],
    // 実測では、明確に一致していても 0.86 程度に落ち着くことがあった（説明に傷の言及があると下がる）。
    threshold: 0.85,
  },
  {
    id: "price_is_plausible",
    is: "`value.price`（円）が、`value.title` と `value.body` の内容に対して極端に相場から外れていない（桁が違う、無料に近い、法外に高い）。`context.price_guide` の目安も参照する",
    uncertainMessage: "価格が相場から外れているかどうかの判断がつきませんでした。",
    message: "価格が商品の内容と合っていません。見直してください。",
    path: ["price"],
    threshold: 0.9,
  },
  {
    id: "description_is_sufficient",
    is: "`value.body` に、購入を検討するために必要な情報（商品の状態、型番やサイズ、付属品、購入時期など）が書かれている",
    uncertainMessage: "説明が十分かどうかの判断がつきませんでした。",
    message: "商品の説明に、状態や付属品などの情報を追記してください。",
    path: ["body"],
    // 実測では、詳しい説明が 0.9 以上、短いだけの説明が 0.1 以下だった。
    // 0.85 のままだと良い出品まで「審査中」に入るため、実データに合わせて下げている。
    threshold: 0.65,
  },
];

/** JEV に渡す参考情報。条件そのものではなく、判断の前提になる資料。 */
export const ListingContext: JevJson = {
  guidelines: [
    "医薬品・市販薬・医療機器、模倣品、現金・ギフトカード番号、アカウントや権利の譲渡、生き物、武器、他人の個人情報は出品できない。",
    "電話番号・メールアドレス・SNS ID・外部サイトの URL の記載は禁止。取引は取引メッセージで行う。",
    "カテゴリーと商品の状態は、商品名と説明の内容と一致していなければならない。",
    "価格は内容に応じた相場の範囲であること。極端に安い・高い出品は購入者の混乱を招くため確認する。",
    "購入判断に必要な情報（状態、型番、付属品、購入時期）が説明に書かれていることが望ましい。",
  ],
  price_guide: [
    "家電・スマホ・カメラ: 中古の一眼カメラ本体は 15,000〜180,000 円程度",
    "コスメ・美容: 未使用品で 500〜12,000 円程度",
    "本・音楽・ゲーム: 500〜8,000 円程度",
    "衣類: 500〜20,000 円程度",
    "おもちゃ・ホビー: 800〜30,000 円程度",
  ],
};

export type ListingMode = "off" | "shadow" | "enforce";
export type ListingStatus = "published" | "review" | "rejected" | "invalid";

/** 運用画面（/ops）で見える 1 件分の記録。 */
/**
 * 条件ごとに、判定に必要なフィールド。
 * 途中チェック（フォーカスを外した時）は、これが揃っている条件だけを JEV に聞く。
 */
export const RULE_FIELDS: Readonly<Record<string, readonly (keyof Listing)[]>> = {
  no_prohibited_items: ["title", "body"],
  no_contact_or_external: ["body"],
  category_matches_item: ["category", "title", "body"],
  condition_matches_description: ["condition", "body"],
  price_is_plausible: ["price", "title", "body"],
  description_is_sufficient: ["body"],
};

/** 1 条件の結果（確率はデモ表示用。判定そのものは issues が正）。 */
export type RuleOutcome = "ok" | "rejected" | "uncertain" | "unavailable" | "skipped";

export interface RuleResult {
  readonly ruleId: string;
  /** 違反を表示する場所（フォームのフィールド名）。無ければ null */
  readonly field: string | null;
  /** 表示用の文言（rejected は違反メッセージ、uncertain は確認メッセージ） */
  readonly message: string;
  /** 聞いていない条件は null */
  readonly probability: number | null;
  readonly threshold: number;
  readonly outcome: RuleOutcome;
}

/**
 * デモ操作パネルが描画する判定ビュー。
 * 出品時（submit）も途中チェック（precheck）も同じ形にして、画面側の分岐を減らす。
 */
export interface JudgmentView {
  readonly origin: "precheck" | "submit";
  /** precheck は "checked"。submit は published / review / rejected */
  readonly status: ListingStatus | "checked";
  readonly id: string | null;
  readonly rules: readonly RuleResult[];
  readonly jev: {
    readonly model: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly latencyMs: number;
    readonly questionCount: number;
    readonly state: unknown;
    readonly questions: unknown;
    readonly answers: unknown;
  };
}

export interface ListingRecord {
  readonly id: string;
  readonly at: string;
  readonly mode: ListingMode;
  readonly status: ListingStatus;
  readonly listing: Listing;
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
  | {
      readonly ok: true;
      readonly id: string;
      readonly status: "published" | "review";
      /** 保存した記録（/ops 用。本番の API では返さないこと） */
      readonly record: ListingRecord;
      /** デモ操作パネル用の判定ビュー */
      readonly judgment: JudgmentView;
    }
  | {
      readonly ok: false;
      /** フィールドごとのエラー（フォームのインライン表示に使う） */
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
      /** フィールドに紐づかないエラー */
      readonly formErrors: readonly string[];
      /** 形式エラーのときは判定していないので undefined */
      readonly record?: ListingRecord;
      readonly judgment?: JudgmentView;
    };

/** フォーカスを外したときの途中チェックの結果（保存しない）。 */
export type PrecheckResult =
  | { readonly ok: true; readonly judgment: JudgmentView }
  | {
      readonly ok: false;
      readonly fieldErrors: Readonly<Record<string, readonly string[]>>;
      readonly formErrors: readonly string[];
    };

/**
 * 記録の保存先。サーバーではメモリ、Cloudflare Workers では Durable Object を使う。
 * `add` は直列に呼ばれる前提でよい（DO は単一インスタンス）。
 */
export interface ListingStore {
  add(record: ListingRecord): Promise<void> | void;
  list(): Promise<readonly ListingRecord[]> | readonly ListingRecord[];
}

/** プロセス内のメモリだけに持つ既定のストア（デモ・テスト用）。 */
export function createMemoryStore(limit = 100): ListingStore {
  const records: ListingRecord[] = [];
  return {
    add(record) {
      records.unshift(record);
      if (records.length > limit) records.pop();
    },
    list() {
      return records;
    },
  };
}

export interface ListingServiceDeps {
  readonly mode: ListingMode;
  readonly apiKey?: string;
  /** テストや --fake で差し替える fetch（省略時はグローバル fetch） */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 記録の保存先（省略時はメモリ） */
  readonly store?: ListingStore;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly limit?: number;
}

interface Capture {
  request: { state?: unknown; questions?: unknown } | null;
  response: { model?: string; answers?: unknown } | null;
  metrics: JevResponseInfo | null;
}

/** フリマの出品 ID 風の文字列。 */
const defaultItemId = (): string =>
  `m${String(Date.now() % 1_000_000_000).padStart(9, "0")}${Math.floor(Math.random() * 90 + 10)}`;

/** フォームの裏側の処理。HTTP からもテストからも同じ経路で呼べる。 */
export function createListingService(deps: ListingServiceDeps) {
  const store = deps.store ?? createMemoryStore(deps.limit ?? 100);
  const now = deps.now ?? (() => new Date());
  const nextId = deps.nextId ?? defaultItemId;

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
  const jev =
    deps.mode === "off"
      ? undefined
      : createJevZod({
          apiKey: deps.apiKey,
          fetch: capturingFetch,
          onResponse: (info) => {
            const capture = captures.getStore();
            if (capture !== undefined) capture.metrics = info;
          },
        });

  /** 写真は判定に使わないので state に載せない（無駄なトークンを使わない）。 */
  const toJSON = (listing: Partial<Listing>) => ({
    ...(listing.title === undefined ? {} : { title: listing.title }),
    ...(listing.body === undefined ? {} : { body: listing.body }),
    ...(listing.category === undefined ? {} : { category: listing.category }),
    ...(listing.condition === undefined ? {} : { condition: listing.condition }),
    ...(listing.price === undefined ? {} : { price: listing.price }),
  });

  const semantic = jev?.semantic(ListingShape, ListingRules, {
    context: ListingContext,
    toJSON,
  });

  /** 途中チェックで聞く条件（必要なフィールドが埋まっているものだけ）。 */
  function applicableRules(partial: Partial<Listing>): SemanticRule[] {
    return ListingRules.filter((rule) => {
      const fields = RULE_FIELDS[rule.id] ?? [];
      return fields.every((field) => {
        const value = partial[field];
        return value !== undefined && value !== null && value !== "";
      });
    });
  }

  /** デモ操作パネル用のビュー（聞いた条件は確率つき、聞いていない条件は skipped）。 */
  function buildJudgment(
    origin: JudgmentView["origin"],
    status: JudgmentView["status"],
    id: string | null,
    asked: readonly SemanticRule[],
    issues: readonly SemanticIssue[],
    capture: Capture,
  ): JudgmentView {
    const kinds = new Map<string, RuleOutcome>();
    let unavailable = false;
    for (const issue of issues) {
      if (issue.details.kind === "unavailable") {
        // 通信・応答の失敗は条件を特定できないので、聞いた条件すべてを unavailable にする
        unavailable = true;
        continue;
      }
      kinds.set(issue.details.ruleId, issue.details.kind);
    }
    const answers = (capture.response?.answers ?? {}) as Record<string, { noul?: unknown }>;

    const rules: RuleResult[] = ListingRules.map((rule) => {
      const field = typeof rule.path?.[0] === "string" ? rule.path[0] : null;
      const index = asked.findIndex((candidate) => candidate.id === rule.id);
      if (index < 0) {
        return {
          ruleId: rule.id,
          field,
          message: rule.message,
          probability: null,
          threshold: rule.threshold ?? 0.95,
          outcome: "skipped",
        };
      }
      const noul = answers[`q${index}`]?.noul;
      const outcome = kinds.get(rule.id) ?? (unavailable ? "unavailable" : "ok");
      return {
        ruleId: rule.id,
        field,
        message:
          outcome === "uncertain"
            ? (rule.uncertainMessage ?? "判断が割れています。人が確認します。")
            : rule.message,
        probability: typeof noul === "number" ? noul : null,
        threshold: rule.threshold ?? 0.95,
        outcome,
      };
    });

    return {
      origin,
      status,
      id,
      rules,
      jev: {
        model: capture.metrics?.model || capture.response?.model || null,
        inputTokens: capture.metrics?.inputTokens ?? 0,
        outputTokens: capture.metrics?.outputTokens ?? 0,
        latencyMs: capture.metrics?.latencyMs ?? 0,
        questionCount: capture.metrics?.questionCount ?? asked.length,
        state: capture.request?.state ?? null,
        questions: capture.request?.questions ?? null,
        answers: capture.response?.answers ?? null,
      },
    };
  }

  function buildRecord(
    status: ListingStatus,
    listing: Listing,
    issues: readonly SemanticIssue[],
    capture: Capture,
    id: string,
  ): ListingRecord {
    return {
      id,
      at: now().toISOString(),
      mode: deps.mode,
      status,
      listing,
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
      const shape = ListingShape.safeParse(raw);
      if (!shape.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of shape.error.issues) {
          const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
          (fieldErrors[field] ??= []).push(issue.message);
        }
        return { ok: false, fieldErrors, formErrors: [] };
      }

      const listing = shape.data;
      const capture: Capture = { request: null, response: null, metrics: null };

      // (2) 意味: 非同期。6 条件を 1 リクエストにまとめて送る。
      let issues: readonly SemanticIssue[] = [];
      if (semantic !== undefined) {
        await captures.run(capture, async () => {
          const result = await semantic.safeParseAsync(raw);
          if (!result.success) issues = getSemanticIssues(result.error);
        });
      }

      // (3) プロダクト状態への写像（ここがチームのポリシー）
      const id = nextId();
      const rejected = issues.filter((issue) => issue.details.kind === "rejected");

      if (deps.mode === "enforce" && rejected.length > 0) {
        const fieldErrors: Record<string, string[]> = {};
        const formErrors: string[] = [];
        for (const issue of rejected) {
          const field = typeof issue.path[0] === "string" ? issue.path[0] : undefined;
          if (field === undefined) formErrors.push(issue.message);
          else (fieldErrors[field] ??= []).push(issue.message);
        }
        // 弾いた出品も運用画面には残す（どんな出品が差し戻されたかを見るため）
        const record = buildRecord("rejected", listing, issues, capture, id);
        await store.add(record);
        return {
          ok: false,
          fieldErrors,
          formErrors,
          record,
          judgment: buildJudgment("submit", "rejected", id, ListingRules, issues, capture),
        };
      }

      // uncertain / unavailable は受け付けて「審査中」。shadow / off は記録だけで「公開中」。
      const status: "published" | "review" =
        deps.mode === "enforce" && issues.length > 0 ? "review" : "published";
      const record = buildRecord(status, listing, issues, capture, id);
      await store.add(record);
      return {
        ok: true,
        id,
        status,
        record,
        judgment: buildJudgment("submit", status, id, ListingRules, issues, capture),
      };
    },

    /**
     * フォーカスを外したときの途中チェック。保存はせず、判定だけを返す。
     * 形が足りない条件は JEV に聞かない（未入力の値について無駄な判断をさせないため）。
     */
    async precheck(raw: unknown): Promise<PrecheckResult> {
      // 空欄は「まだ入力していない」として扱う（空文字を数値化すると不正値になってしまうため）
      const entered = Object.fromEntries(
        Object.entries(typeof raw === "object" && raw !== null ? raw : {}).filter(
          ([, value]) => value !== "" && value !== null && value !== undefined,
        ),
      );
      const shape = ListingShape.partial().safeParse(entered);
      if (!shape.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of shape.error.issues) {
          const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
          (fieldErrors[field] ??= []).push(issue.message);
        }
        return { ok: false, fieldErrors, formErrors: [] };
      }

      const capture: Capture = { request: null, response: null, metrics: null };
      const asked = applicableRules(shape.data);
      let issues: readonly SemanticIssue[] = [];

      if (jev !== undefined && asked.length > 0) {
        // 聞く条件だけのスキーマを組み立てる（作り直しは設定だけなので I/O は無い）
        const schema = jev.semantic(ListingShape.partial(), asked, {
          context: ListingContext,
          toJSON,
        });
        await captures.run(capture, async () => {
          const result = await schema.safeParseAsync(entered);
          if (!result.success) issues = getSemanticIssues(result.error);
        });
      }

      return { ok: true, judgment: buildJudgment("precheck", "checked", null, asked, issues, capture) };
    },

    /** 運用画面用。新しい順。 */
    async list(): Promise<readonly ListingRecord[]> {
      return await store.list();
    },
  };
}
