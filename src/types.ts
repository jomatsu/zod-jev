import type * as Z from "zod";
import type {
  EntryType,
  JsonValue,
  LogLevel,
  NoulQuestion,
  Questions,
  RequestOptions,
  RetryPolicy,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";

/**
 * Jev が受理する JSON 値。公式 SDK の `JsonValue` と同じ定義。
 * `Date` / `Map` / `undefined` は含まれない（`SemanticOptions.toJSON` で変換する）。
 */
export type JevJson = JsonValue;

/** `instructions` と Noul の `criteria` に渡せる値。 */
export type JevEntry = EntryType;

/**
 * このライブラリが要求するクライアントの最小面。
 * 公式 `TypeSafeClient` をそのまま渡せるので、実装はテスト用のスタブ以外では不要。
 */
export interface JevClient {
  systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): PromiseLike<SystemOneResult<Q>>;
}

/**
 * 意味検証を完了できなかった理由。
 * 生の例外メッセージや応答本文はここに含めない（機密や内部情報を漏らさないため）。
 */
export type JevUnavailableReason =
  | "timeout"
  | "network"
  | "http"
  | "malformed_response"
  | "not_json"
  | "state_too_large"
  | "unknown";

/**
 * Zod issue の `params.semantic` に載る判定結果。
 *
 * - `rejected`: P(条件が真) が下限以下。条件が明確に成立していない。
 * - `uncertain`: 下限と閾値の間。肯定とも否定とも言い切れない。
 * - `unavailable`: 判定そのものが得られなかった（通信・応答・入力の問題）。
 */
export type SemanticIssueDetails =
  | {
      readonly kind: "rejected" | "uncertain";
      readonly ruleId: string;
      readonly probability: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: JevUnavailableReason;
      readonly status?: number;
    };

/** 1つの意味条件。`id` はスキーマ内で一意にする。 */
export interface SemanticRule {
  /** アプリ側で扱う安定した条件ID。例外と issue から参照する。 */
  readonly id: string;
  /**
   * 成立してほしい条件。**「はい」で確率が 1 に近づく問い**として書く。
   * 既定ではこの文字列がそのまま Jev の `instructions.question` になる。
   */
  readonly is: string;
  /** 条件が成立していない（`rejected`）と判定したときに表示する、開発者が定義したメッセージ。 */
  readonly message: string;
  /** このスキーマからの相対的なエラーパス。式の抽出には使わず、issue の位置付けにだけ使う。 */
  readonly path?: readonly (string | number)[];
  /** 合格に必要な P(条件が真)。0.5 < threshold <= 1。既定は `JevZodConfig.threshold`。 */
  readonly threshold?: number;
  /** `uncertain` と判定したときのメッセージ。既定は「確認が必要です」。 */
  readonly uncertainMessage?: string;
  /**
   * Jev に送る `instructions` 全体を差し替える。
   * 文字列・オブジェクト・配列・null が使える（構造化したほうが問いが明確になる）。
   */
  readonly instructions?: JevEntry;
  /** Noul の `criteria.true` / `criteria.false` を差し替える。 */
  readonly criteria?: NoulQuestion["criteria"];
}

/** `semantic()` の呼び出しオプション。 */
export interface SemanticOptions<T> {
  /** 参考情報。入力値とは別に、ポリシーや根拠文書などを渡す。条件そのものの判定には使わせない。 */
  readonly context?: JevJson;
  /** `Date` や `Map` など JSON でない出力型を、明示的に JSON へ変換する。 */
  readonly toJSON?: (value: T) => JevJson;
  /** この検証のリクエストを取り消すためのシグナル。 */
  readonly signal?: AbortSignal;
}

/** `semanticArray()` の呼び出しオプション。 */
export interface SemanticArrayOptions<T> extends SemanticOptions<T> {
  /**
   * 1リクエストにまとめる質問数の上限。要素数 × 条件数がこれを超えると、
   * 複数リクエストに分割する。既定 128。
   */
  readonly maxQuestionsPerRequest?: number;
}

/** 1リクエスト分の利用状況。コストと遅延の観測用。 */
export interface JevResponseInfo {
  /** 応答したモデル（`jev-latest` など）。 */
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** リクエスト開始から応答までのミリ秒。 */
  readonly latencyMs: number;
  /** このリクエストに含めた質問数。 */
  readonly questionCount: number;
}

/** `unavailable` メッセージを組み立てるための情報。 */
export interface JevUnavailableContext {
  readonly reason: JevUnavailableReason;
  readonly status?: number;
  readonly characters?: number;
  readonly maxCharacters?: number;
  /** 応答に欠けていた質問キー。 */
  readonly questionId?: string;
}

/** 既定メッセージの差し替え。部分指定で、指定した分だけ置き換わる。 */
export interface JevMessages {
  /** `uncertain` と判定したときのメッセージ。 */
  uncertain(rule: SemanticRule): string;
  /** `unavailable` を issue にするときのメッセージ。 */
  unavailable(info: JevUnavailableContext): string;
}

/**
 * `createJevZod()` の設定。
 *
 * `apiKey` / `baseURL` / `model` を省略した場合は公式 SDK と同じ環境変数
 * （`TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL`）を読む。
 */
export interface JevZodConfig {
  /** TypeSafe の API キー。省略時は `TYPESAFE_API_KEY`。 */
  readonly apiKey?: string;
  /** API のルート URL。省略時は `TYPESAFE_BASE_URL` → `https://api.typesafe.ai`。 */
  readonly baseURL?: string;
  /** 使用するモデル。省略時は `TYPESAFE_DEFAULT_MODEL` → `jev-latest`。 */
  readonly model?: string;
  /** 既定の閾値。0.5 < threshold <= 1。既定 0.95。 */
  readonly threshold?: number;
  /** 1回の試行のタイムアウト（ミリ秒）。SDK の既定は 10000。 */
  readonly timeoutMs?: number;
  /** 初回を除く最大リトライ回数。既定は SDK と同じ 2。 */
  readonly maxRetries?: number;
  /** SDK のリトライ方針を細かく指定する。 */
  readonly retry?: Partial<RetryPolicy>;
  /** `fetch` の差し替え。テストや独自トランスポート用。 */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * 事前構成済みのクライアント。指定した場合、`apiKey` / `baseURL` / `fetch` /
   * `retry` / `timeoutMs` / `maxRetries` / `logLevel` は使われない。
   */
  readonly client?: JevClient;
  /** 公式 SDK のログレベル。 */
  readonly logLevel?: LogLevel;
  /**
   * state + questions の文字数上限。既定 150,000（Jev の約 32,000 トークン予算に相当）。
   * 超えた場合は API を叩かずに `state_too_large` を返す。
   */
  readonly maxStateCharacters?: number;
  /**
   * リトライしても解決しない 4xx（400/401/403/404/422 など）の扱い。
   * `"throw"`（既定）は例外、`"issue"` は `unavailable` の issue にする。
   */
  readonly onClientError?: "throw" | "issue";
  /** リクエストごとの観測フック。 */
  readonly onResponse?: (info: JevResponseInfo) => void;
  /** 既定メッセージの差し替え。 */
  readonly messages?: Partial<JevMessages>;
}

/**
 * 意味検証を合成したスキーマ。
 *
 * 実体は `base` に非同期の refine を足した**同じ型**のスキーマ（clone）で、
 * `ZodObject` なら `.extend()` / `.pick()` / `.partial()` もそのまま使える。
 * 逆に、型だけでは「非同期になった」ことが分からないため、
 * このスキーマを経由する parse は必ず `parseAsync` / `safeParseAsync` を使うこと。
 */
export type ZodSemantic<S extends Z.ZodType> = S;

/** 各要素を Jev で検証する配列スキーマ。 */
export type ZodSemanticArray<S extends Z.ZodType> = Z.ZodArray<S>;

/** `createJevZod()` が返す `semantic`。 */
export interface SemanticFactory {
  <S extends Z.ZodType>(
    base: S,
    rules: readonly SemanticRule[],
    options?: SemanticOptions<Z.output<S>>,
  ): ZodSemantic<S>;
}

/** `createJevZod()` が返す `semanticArray`。 */
export interface SemanticArrayFactory {
  <S extends Z.ZodType>(
    base: S,
    rules: readonly SemanticRule[],
    options?: SemanticArrayOptions<Z.output<S>>,
  ): ZodSemanticArray<S>;
}
