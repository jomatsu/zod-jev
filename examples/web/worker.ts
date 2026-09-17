/**
 * Cloudflare Workers 版のデモ。
 *
 * examples/web の review.ts をそのまま使い、判定をサーバー側（Workers）で実行します。
 *
 *   npx wrangler deploy --config examples/web/wrangler.jsonc
 *   npx wrangler secret put TYPESAFE_API_KEY --config examples/web/wrangler.jsonc
 *
 * - API キーは Secret に置く。ブラウザには渡らない
 * - 静的ファイルは Workers Assets から配信し、`/ops` だけ ops.html にマップする
 * - 受け付けた投稿は Durable Object（ReviewStore）に永続化する。
 *   Workers は isolate が複数あるので、モジュールスコープのメモリでは
 *   リクエストごとに別の記録を見てしまう（実測でそうなった）ため。
 */
import { DEFAULT_THRESHOLD } from "../../src/index.js";
import { fakeFetch, samples } from "./fake.js";
import {
  createReviewService,
  ReviewRules,
  type ReviewMode,
  type Submission,
  type SubmissionStore,
} from "./review.js";

/** Durable Object のストレージ（構造だけ要求して、型定義パッケージに依存しない）。 */
interface DurableObjectStateLike {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

export interface Env {
  /** Workers Assets バインディング（wrangler.jsonc の assets.binding） */
  readonly ASSETS: { fetch(input: Request | URL | string): Promise<Response> };
  /**
   * Durable Object の**名前空間**バインディング。
   * スタブ（実際のインスタンス）は `get(idFromName("reviews"))` で取る。
   */
  readonly REVIEW_STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  };
  /** `wrangler secret put TYPESAFE_API_KEY` で設定する */
  readonly TYPESAFE_API_KEY?: string;
  /** enforce（既定） / shadow / off。キルスイッチとして使える */
  readonly REVIEW_MODE?: string;
  /** "1" にすると JEV を呼ばず、偽の判定で動く（課金なしで画面を確認する用） */
  readonly FAKE_JEV?: string;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const STORAGE_KEY = "submissions";
const STORE_LIMIT = 100;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** 記録を集約する単一の Durable Object スタブ（名前で固定する）。 */
const storeStub = (env: Env) => env.REVIEW_STORE.get(env.REVIEW_STORE.idFromName("reviews"));

/** Durable Object を保存先として使うアダプタ。 */
const durableStore = (env: Env): SubmissionStore => ({
  async add(submission: Submission): Promise<void> {
    await storeStub(env).fetch("https://review-store/add", {
      method: "POST",
      body: JSON.stringify(submission),
    });
  },
  async list(): Promise<readonly Submission[]> {
    const response = await storeStub(env).fetch("https://review-store/list");
    const body = (await response.json()) as { submissions: Submission[] };
    return body.submissions;
  },
});

let cached:
  | { readonly key: string; readonly service: ReturnType<typeof createReviewService> }
  | undefined;

function getService(env: Env) {
  const mode: ReviewMode =
    env.REVIEW_MODE === "off" || env.REVIEW_MODE === "shadow" ? env.REVIEW_MODE : "enforce";
  const fake = env.FAKE_JEV === "1" || env.FAKE_JEV === "true";
  const key = `${mode}:${fake}:${env.TYPESAFE_API_KEY === undefined ? "no-key" : "key"}`;

  if (cached === undefined || cached.key !== key) {
    cached = {
      key,
      service: createReviewService({
        mode,
        store: durableStore(env),
        ...(fake ? { apiKey: "fake-key", fetch: fakeFetch() } : { apiKey: env.TYPESAFE_API_KEY }),
      }),
    };
  }
  return { service: cached.service, mode, fake };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/meta") {
        const { mode, fake } = getService(env);
        return json({
          mode,
          fake,
          endpoint: ENDPOINT,
          defaultThreshold: DEFAULT_THRESHOLD,
          rules: ReviewRules.map((rule) => ({
            id: rule.id,
            is: rule.is,
            message: rule.message,
            threshold: rule.threshold ?? DEFAULT_THRESHOLD,
          })),
          samples,
        });
      }

      if (url.pathname === "/api/reviews" && request.method === "POST") {
        const { service } = getService(env);
        const input = await request.json().catch(() => null);
        const result = await service.submit(input);
        return json(result, result.ok ? 201 : 422);
      }

      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const { service } = getService(env);
        return json({ submissions: await service.list() });
      }

      if (url.pathname === "/api/reviews") {
        return json({ error: "method not allowed" }, 405);
      }

      if (url.pathname === "/ops" || url.pathname === "/ops/") {
        return env.ASSETS.fetch(new URL("/ops.html", url));
      }

      // 静的ファイルは Workers Assets が直接返すので、通常ここには来ない
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[worker]", message);
      if (message.includes("API key")) {
        return json(
          {
            error:
              "TYPESAFE_API_KEY が未設定です。`npx wrangler secret put TYPESAFE_API_KEY --config examples/web/wrangler.jsonc` を実行してください。",
          },
          500,
        );
      }
      return json({ error: "サーバー側でエラーが発生しました" }, 500);
    }
  },
};

/**
 * 受け付けた投稿を保存する Durable Object。
 * 単一インスタンスなので read-modify-write が直列になり、isolate をまたいでも記録が揃う。
 */
export class ReviewStore {
  readonly #state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const submissions = (await this.#state.storage.get<Submission[]>(STORAGE_KEY)) ?? [];

    if (request.method === "POST" && url.pathname === "/add") {
      const submission = (await request.json()) as Submission;
      submissions.unshift(submission);
      if (submissions.length > STORE_LIMIT) submissions.length = STORE_LIMIT;
      await this.#state.storage.put(STORAGE_KEY, submissions);
      return json({ ok: true });
    }

    if (url.pathname === "/list") {
      return json({ submissions });
    }

    return json({ error: "not found" }, 404);
  }
}
