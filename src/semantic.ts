import { TypeSafeClient } from "@typesafe-ai/sdk";
import * as Z from "zod";
import { addNotJson, judge, type JudgeConfig, type JudgmentGroup } from "./judge.js";
import { resolveMessages } from "./messages.js";
import { buildTarget, normalizeRules, parseConfig } from "./rules.js";
import { JevJsonSchema } from "./schema.js";
import type {
  JevClient,
  JevJson,
  JevZodConfig,
  SemanticArrayFactory,
  SemanticFactory,
} from "./types.js";

const Threshold = Z.number().gt(0.5).max(1);
const PositiveInt = Z.number().int().positive();
const NonNegativeInt = Z.number().int().nonnegative();
const PositiveMs = Z.number().int().positive().max(2_147_483_647);
const Model = Z.string().trim().min(1);
const OnClientError = Z.enum(["throw", "issue"]);

/** JEV の state と questions が共有する予算（約 32,000 トークン ≈ 150,000 文字）の既定値。 */
export const DEFAULT_MAX_STATE_CHARACTERS = 150_000;

/** 既定の閾値。 */
export const DEFAULT_THRESHOLD = 0.95;

/** `semanticArray()` が 1 リクエストに載せる質問数の既定値。 */
export const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 128;

interface Resolved {
  readonly threshold: number;
  readonly messages: ReturnType<typeof resolveMessages>;
  readonly judge: Omit<JudgeConfig, "signal">;
}

/** 設定を検証し、公式 SDK のクライアントを組み立てる。 */
function resolveConfig(config: JevZodConfig): Resolved {
  const threshold = parseConfig(Threshold, config.threshold ?? DEFAULT_THRESHOLD, "threshold");
  const maxStateCharacters = parseConfig(
    PositiveInt,
    config.maxStateCharacters ?? DEFAULT_MAX_STATE_CHARACTERS,
    "maxStateCharacters",
  );
  const onClientError = parseConfig(
    OnClientError,
    config.onClientError ?? "throw",
    "onClientError",
  );
  const model =
    config.model === undefined ? undefined : parseConfig(Model, config.model, "model");
  const timeoutMs =
    config.timeoutMs === undefined
      ? undefined
      : parseConfig(PositiveMs, config.timeoutMs, "timeoutMs");
  const maxRetries =
    config.maxRetries === undefined
      ? undefined
      : parseConfig(NonNegativeInt, config.maxRetries, "maxRetries");

  const client: JevClient =
    config.client ??
    new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: timeoutMs,
      logLevel: config.logLevel,
      fetch: config.fetch,
      retry:
        config.retry === undefined && maxRetries === undefined
          ? undefined
          : { ...config.retry, ...(maxRetries === undefined ? {} : { maxRetries }) },
    });

  return {
    threshold,
    messages: resolveMessages(config.messages),
    judge: {
      client,
      model,
      maxStateCharacters,
      onClientError,
      onResponse: config.onResponse,
      messages: resolveMessages(config.messages),
    },
  };
}

/**
 * Zod 4 + TypeSafe JEV のスキーマビルダーを作る。
 *
 * ```
 * const z = createJevZod({ apiKey: process.env.TYPESAFE_API_KEY });
 * const schema = z.semantic(z.object({ body: z.string() }), [
 *   { id: "no_pii", is: "`body` に個人情報が含まれていない", message: "個人情報を削除してください" },
 * ]);
 * const result = await schema.safeParseAsync(value); // 非同期必須
 * ```
 *
 * `semantic()` は1回の parse につき JEV を**1回**だけ呼び、そのスキーマの条件を
 * まとめて1リクエストに載せる。条件を増やしてもレイテンシはほとんど増えない。
 */
export function createJevZod(config: JevZodConfig = {}) {
  const resolved = resolveConfig(config);

  const semantic: SemanticFactory = (base, rules, options = {}) => {
    const checks = normalizeRules(rules, resolved.threshold);
    const context = parseConfig(JevJsonSchema, options.context ?? null, "options.context");
    const hasContext = options.context !== undefined && options.context !== null;
    const targets = checks.map((check) =>
      buildTarget(check, { key: check.key, judge: "value", path: check.path, hasContext }),
    );
    const judgeConfig: JudgeConfig = { ...resolved.judge, signal: options.signal };

    // 入力の型・形式は base が検証済みなので、ここでは意味だけを検証する。
    // pipe ではなく base 自身に refine を足すことで、ZodObject の `.extend()` や
    // 構造化出力用の JSON Schema 変換（`z.toJSONSchema`）がそのまま使える。
    // 子の形式エラーがあるときは refine が走らないので、無駄なリクエストも出ない。
    return base.superRefine(async (value, ctx) => {
      let json: JevJson;
      try {
        json = JevJsonSchema.parse(
          options.toJSON === undefined ? value : options.toJSON(value),
        );
      } catch {
        addNotJson(ctx, resolved.messages);
        return;
      }

      await judge(ctx, judgeConfig, [{ value: json, targets }], { context, hasContext });
    });
  };

  const semanticArray: SemanticArrayFactory = (base, rules, options = {}) => {
    const checks = normalizeRules(rules, resolved.threshold);
    const context = parseConfig(JevJsonSchema, options.context ?? null, "options.context");
    const hasContext = options.context !== undefined && options.context !== null;
    const maxQuestions = parseConfig(
      PositiveInt,
      options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST,
      "options.maxQuestionsPerRequest",
    );
    const judgeConfig: JudgeConfig = { ...resolved.judge, signal: options.signal };
    const items = Z.array(base);
    const perRequest = Math.max(1, Math.floor(maxQuestions / checks.length));

    // 要素ごとに1リクエストだと API 呼び出しが要素数分になる。
    // 要素をまとめて1リクエストに載せ、条件を要素ぶんの質問に展開する。
    return items.superRefine(async (value, ctx) => {
      const jsonItems: JevJson[] = [];
      try {
        for (const item of value) {
          jsonItems.push(
            JevJsonSchema.parse(options.toJSON === undefined ? item : options.toJSON(item)),
          );
        }
      } catch {
        addNotJson(ctx, resolved.messages);
        return;
      }

      const groups: JudgmentGroup[] = [];
      for (let start = 0; start < jsonItems.length; start += perRequest) {
        const slice = jsonItems.slice(start, start + perRequest);
        const targets = slice.flatMap((_, offset) =>
          checks.map((check, checkIndex) =>
            buildTarget(check, {
              key: `q${offset}c${checkIndex}`,
              // state にはこのリクエストの要素だけを載せるので、添字はスライス内の位置で指す。
              judge: `value[${offset}]`,
              path: [start + offset, ...check.path],
              hasContext,
            }),
          ),
        );
        groups.push({ value: slice, targets });
      }

      await judge(ctx, judgeConfig, groups, { context, hasContext });
    });
  };

  return { ...Z, semantic, semanticArray };
}

/** `createJevZod()` の戻り値。 */
export type JevZod = ReturnType<typeof createJevZod>;
