import type { JevZodConfig } from "../src/index.js";

/** テスト用に記録したリクエスト。 */
export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  /** 小文字に正規化したヘッダ。 */
  readonly headers: Record<string, string>;
  /** JSON として解釈したリクエストボディ。 */
  readonly body: any;
}

export interface Question {
  readonly key: string;
  /** noul の質問文（`instructions` が文字列ならそれ、構造化されていれば `question`）。 */
  readonly text: string;
  readonly raw: any;
}

export interface FetchRecorder {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly calls: RecordedCall[];
}

/** `fetch` を差し替えて、送信内容を記録する。 */
export function recordingFetch(
  handler: (call: RecordedCall, init: RequestInit) => Response | Promise<Response>,
): FetchRecorder {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, init ?? {});
  };
  return { fetch, calls };
}

/** 小文字キーの辞書にする。`HeadersInit` のどの形でも受け取れるようにしておく。 */
function normalizeHeaders(raw: RequestInit["headers"]): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw === undefined) return headers;
  if (raw instanceof Headers) {
    for (const [name, value] of raw) headers[name.toLowerCase()] = value;
    return headers;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) headers[String(entry[0]).toLowerCase()] = String(entry[1]);
    return headers;
  }
  for (const [name, value] of Object.entries(raw)) {
    headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

/** 送った question を key と質問文に分解する。 */
export function readQuestions(body: any): Question[] {
  const questions: Record<string, any> = body?.questions ?? {};
  return Object.entries(questions).map(([key, raw]) => ({
    key,
    text:
      typeof raw?.instructions === "string"
        ? raw.instructions
        : String(raw?.instructions?.question ?? ""),
    raw,
  }));
}

/**
 * 質問文ごとに確率を返す fetch ハンドラ。
 * 表にない質問は合格扱い（0.99）にして、テストが不要な項目に触れずに済むようにする。
 */
export function answering(
  probabilities: Record<string, number> = {},
  options: { status?: number; body?: unknown; usage?: boolean } = {},
): (call: RecordedCall) => Response {
  return (call) => {
    if (options.status !== undefined && options.status >= 400) {
      return jsonResponse(options.body ?? { error: "upstream failure" }, {
        status: options.status,
        headers: { "retry-after": "0" },
      });
    }
    const answers = Object.fromEntries(
      readQuestions(call.body).map((question) => [
        question.key,
        { type: "noul", noul: probabilities[question.text] ?? 0.99 },
      ]),
    );
    return jsonResponse({
      model: "jev-latest",
      answers,
      ...(options.usage === false ? {} : { usage: { input_tokens: 11, output_tokens: 7 } }),
    });
  };
}

/**
 * 質問の並び順で確率を決めるハンドラ。`semanticArray()` のように
 * 同じ質問文が要素ぶん並ぶケースで、要素ごとの結果を作るのに使う。
 */
export function answeringPerQuestion(
  probability: (info: { index: number; question: Question; body: any }) => number,
): (call: RecordedCall) => Response {
  return (call) => {
    const answers = Object.fromEntries(
      readQuestions(call.body).map((question, index) => [
        question.key,
        { type: "noul", noul: probability({ index, question, body: call.body }) },
      ]),
    );
    return jsonResponse({
      model: "jev-latest",
      answers,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  };
}

/** 常に abort に反応しない（タイムアウトを起こす）fetch。 */
export function hangingFetch(): FetchRecorder {
  return recordingFetch(
    (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      }),
  );
}

/** リトライ待ちをゼロにしてテストを速くする。 */
export function testConfig(recorder: FetchRecorder, overrides: Partial<JevZodConfig> = {}): JevZodConfig {
  return {
    apiKey: "test-key",
    fetch: recorder.fetch,
    retry: { backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
    ...overrides,
  };
}
