/**
 * デモ web アプリの HTTP 層（ローカル実行用）。
 *
 *   npx tsx examples/web/server.ts                  # 実 API（TYPESAFE_API_KEY / .env）
 *   npx tsx examples/web/server.ts --fake           # 偽の Jev（鍵不要・課金なし）
 *   npx tsx examples/web/server.ts --mode=shadow    # 判定はするが挙動は変えない（観測）
 *   npx tsx examples/web/server.ts --mode=off       # Jev を呼ばない（キルスイッチ）
 *
 *   /      利用者向け: フリマアプリの出品画面（Jev の存在は見せない）
 *   /ops   開発者向け: 裏で何を判定したか（確率・送信内容・トークン）
 *
 * API キーはこのプロセスにだけ置きます。ブラウザには渡しません。
 * Cloudflare Workers 版は worker.ts / wrangler.jsonc。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
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
} from "./listing.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const args = process.argv.slice(2);
const fake = args.includes("--fake");
const modeArg = args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
const mode: ListingMode = modeArg === "off" || modeArg === "shadow" ? modeArg : "enforce";
const port = Number(process.env.PORT ?? 5178);
const apiKey = process.env.TYPESAFE_API_KEY;

// mode: off（キルスイッチ）なら Jev のクライアントを作らないので、鍵が無くても起動できる
if (!fake && mode !== "off" && (apiKey === undefined || apiKey === "")) {
  console.error("TYPESAFE_API_KEY が必要です（鍵無しで試すなら --fake、判定を切るなら --mode=off）");
  process.exit(1);
}

const service = createListingService({
  mode,
  ...(fake ? { apiKey: "fake-key", fetch: fakeFetch() } : { apiKey }),
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error("[demo] unhandled error:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "サーバー側でエラーが発生しました" });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (request.method === "POST" && url.pathname === "/api/listings") {
    const input = await readJson(request);
    const { record, judgment, ...result } = await service.submit(input);
    void record; // 記録は /ops 側で使う。API では返さない
    // 出品できない場合は 422（フォームのバリデーションエラーとして返す）
    // demo はデモ操作パネル用の裏側の判定内容。本番の API では返さないこと。
    return sendJson(response, result.ok ? 201 : 422, { ...result, demo: judgment ?? null });
  }

  if (request.method === "POST" && url.pathname === "/api/listings/check") {
    // フォーカスを外したときの途中チェック（保存しない）
    const input = await readJson(request);
    return sendJson(response, 200, await service.precheck(input));
  }

  if (request.method === "GET" && url.pathname === "/api/listings") {
    return sendJson(response, 200, { records: await service.list() });
  }

  if (request.method === "GET" && url.pathname === "/api/meta") {
    return sendJson(response, 200, {
      mode,
      fake,
      endpoint: "https://api.typesafe.ai/v1/systemone",
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

  if (request.method === "GET") {
    if (url.pathname === "/ops") return serveStatic("ops.html", response);
    return serveStatic(url.pathname === "/" ? "index.html" : url.pathname.slice(1), response);
  }

  sendJson(response, 405, { error: "method not allowed" });
}

async function serveStatic(name: string, response: ServerResponse): Promise<void> {
  if (!/^[\w.-]+$/.test(name)) return sendJson(response, 404, { error: "not found" });
  const extension = name.slice(name.lastIndexOf("."));
  try {
    const content = await readFile(fileURLToPath(new URL(`./public/${name}`, import.meta.url)));
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "not found" });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

server.listen(port, () => {
  console.log(`出品画面（利用者向け）: http://localhost:${port}/`);
  console.log(`裏側（開発者向け）:     http://localhost:${port}/ops`);
  console.log(`  mode=${mode}${fake ? " / --fake（偽の判定・課金なし）" : " / 実 API"}`);
});
