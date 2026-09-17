/**
 * Cloudflare Workers 版のデモ（https://zod-jev.jomatsu.me/）。
 *
 * examples/web の listing.ts をそのまま使い、判定をサーバー側（Workers）で実行します。
 *
 *   npx wrangler deploy --config examples/web/wrangler.jsonc
 *   npx wrangler secret put TYPESAFE_API_KEY --config examples/web/wrangler.jsonc
 *
 * - API キーは Secret に置く。ブラウザには渡らない
 * - 静的ファイルは Workers Assets から配信し、`/ops` だけ ops.html にマップする
 * - 出品の記録は Durable Object（ListingStore）に永続化する。
 *   Workers は isolate が複数あるので、モジュールスコープのメモリでは
 *   リクエストごとに別の記録を見てしまう（実測でそうなった）ため。
 */
import { DEFAULT_THRESHOLD } from "../../src/index.js";
import { fakeFetch, samples } from "./fake.js";
import {
  CATEGORIES,
  CONDITIONS,
  createListingService,
  FEE_RATE,
  ListingRules,
  SHIPPING_DAYS,
  SHIPPING_FEES,
  type ListingMode,
  type ListingRecord,
  // Durable Object のクラス名（ListingStore）と衝突するので別名で取り込む
  type ListingStore as ListingStorePort,
} from "./listing.js";

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
   * スタブ（実際のインスタンス）は `get(idFromName("listings"))` で取る。
   */
  readonly LISTING_STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  };
  /** `wrangler secret put TYPESAFE_API_KEY` で設定する */
  readonly TYPESAFE_API_KEY?: string;
  /** enforce（既定） / shadow / off。キルスイッチとして使える */
  readonly REVIEW_MODE?: string;
  /** "1" にすると Jev を呼ばず、偽の判定で動く（課金なしで画面を確認する用） */
  readonly FAKE_JEV?: string;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const STORAGE_KEY = "listings";
const STORE_LIMIT = 100;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** 記録を集約する単一の Durable Object スタブ（名前で固定する）。 */
const storeStub = (env: Env) => env.LISTING_STORE.get(env.LISTING_STORE.idFromName("listings"));

/** Durable Object を保存先として使うアダプタ。 */
const durableStore = (env: Env): ListingStorePort => ({
  async add(record: ListingRecord): Promise<void> {
    await storeStub(env).fetch("https://listing-store/add", {
      method: "POST",
      body: JSON.stringify(record),
    });
  },
  async list(): Promise<readonly ListingRecord[]> {
    const response = await storeStub(env).fetch("https://listing-store/list");
    const body = (await response.json()) as { records: ListingRecord[] };
    return body.records;
  },
});

let cached:
  | { readonly key: string; readonly service: ReturnType<typeof createListingService> }
  | undefined;

function getService(env: Env) {
  const mode: ListingMode =
    env.REVIEW_MODE === "off" || env.REVIEW_MODE === "shadow" ? env.REVIEW_MODE : "enforce";
  const fake = env.FAKE_JEV === "1" || env.FAKE_JEV === "true";
  const key = `${mode}:${fake}:${env.TYPESAFE_API_KEY === undefined ? "no-key" : "key"}`;

  if (cached === undefined || cached.key !== key) {
    cached = {
      key,
      service: createListingService({
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
          feeRate: FEE_RATE,
          options: {
            categories: CATEGORIES,
            conditions: CONDITIONS,
            shippingFees: SHIPPING_FEES,
            shippingDays: SHIPPING_DAYS,
          },
          rules: ListingRules.map((rule) => ({
            id: rule.id,
            is: rule.is,
            message: rule.message,
            threshold: rule.threshold ?? DEFAULT_THRESHOLD,
          })),
          samples,
        });
      }

      if (url.pathname === "/api/listings" && request.method === "POST") {
        const { service } = getService(env);
        const input = await request.json().catch(() => null);
        const { record, judgment, ...result } = await service.submit(input);
        void record; // 記録は /ops 側で使う。API では返さない
        // demo はデモ操作パネル用の裏側の判定内容。本番の API では返さないこと。
        return json({ ...result, demo: judgment ?? null }, result.ok ? 201 : 422);
      }

      if (url.pathname === "/api/listings/check" && request.method === "POST") {
        // フォーカスを外したときの途中チェック（保存しない）
        const { service } = getService(env);
        const input = await request.json().catch(() => null);
        return json(await service.precheck(input));
      }

      if (url.pathname === "/api/listings" && request.method === "GET") {
        const { service } = getService(env);
        return json({ records: await service.list() });
      }

      if (url.pathname === "/api/listings") {
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
 * 出品の記録を保存する Durable Object。
 * 単一インスタンスなので read-modify-write が直列になり、isolate をまたいでも記録が揃う。
 */
export class ListingStore {
  readonly #state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const records = (await this.#state.storage.get<ListingRecord[]>(STORAGE_KEY)) ?? [];

    if (request.method === "POST" && url.pathname === "/add") {
      const record = (await request.json()) as ListingRecord;
      records.unshift(record);
      if (records.length > STORE_LIMIT) records.length = STORE_LIMIT;
      await this.#state.storage.put(STORAGE_KEY, records);
      return json({ ok: true });
    }

    if (url.pathname === "/list") {
      return json({ records });
    }

    return json({ error: "not found" }, 404);
  }
}
