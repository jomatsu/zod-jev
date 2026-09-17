import {
  APIError,
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  noul,
} from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { Target } from "./rules.js";
import { ResponseSchema } from "./schema.js";
import type {
  JevClient,
  JevJson,
  JevMessages,
  JevResponseInfo,
  JevUnavailableContext,
  JevUnavailableReason,
} from "./types.js";

/**
 * `superRefine` のコールバックに渡る context のうち、このライブラリが使う部分だけを
 * 構造として要求する。zod の内部型（`core.$RefinementCtx` は zod 4.1 以降にしか無い）に
 * 依存せず、4.0 系でも型が通るようにするため。
 */
export interface IssueContext {
  addIssue(issue: {
    code: "custom";
    message: string;
    path?: (string | number)[];
    params?: Record<string, unknown>;
  }): void;
}

/** リクエストを組み立てるために固定しておく設定。 */
export interface JudgeConfig {
  readonly client: JevClient;
  readonly model: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly maxStateCharacters: number;
  readonly onClientError: "throw" | "issue";
  readonly onResponse: ((info: JevResponseInfo) => void) | undefined;
  readonly messages: JevMessages;
}

/**
 * 1リクエストにまとめる質問の単位。
 * `value` が state の `value` に入り、`targets` が質問になる。
 */
export interface JudgmentGroup {
  readonly value: JevJson;
  readonly targets: readonly Target[];
}

/** すべてのグループで共有する state。 */
export interface SharedState {
  readonly context: JevJson;
  readonly hasContext: boolean;
}

/**
 * グループごとに JEV を1回呼ぶ。質問は並列・独立に評価されるので、
 * 「この parse で必要な判定」はすべて同じリクエストに載せる（speculative fan-out）。
 * 送った質問のうち、成立しなかったものだけを issue にする。
 */
export async function judge(
  ctx: IssueContext,
  config: JudgeConfig,
  groups: readonly JudgmentGroup[],
  shared: SharedState,
): Promise<void> {
  for (const group of groups) {
    await judgeGroup(ctx, config, group, shared);
  }
}

async function judgeGroup(
  ctx: IssueContext,
  config: JudgeConfig,
  group: JudgmentGroup,
  shared: SharedState,
): Promise<void> {
  if (group.targets.length === 0) return;

  const state: Record<string, JevJson> = { value: group.value };
  if (shared.hasContext) state.context = shared.context;

  const questions: Questions = {};
  for (const target of group.targets) {
    questions[target.key] = noul(target.instructions, target.criteria);
  }

  // JEV の予算（約 32,000 トークン ≈ 150,000 文字）は state と questions の共有。
  // 両方を数えて、超えるなら API を叩かずに落とす。
  const characters = JSON.stringify(state).length + JSON.stringify(questions).length;
  if (characters > config.maxStateCharacters) {
    addUnavailable(ctx, config.messages, [], "state_too_large", {
      characters,
      maxCharacters: config.maxStateCharacters,
    });
    return;
  }

  const startedAt = Date.now();
  let result: SystemOneResult<Questions>;
  try {
    result = await config.client.systemOne(
      {
        state,
        questions,
        ...(config.model === undefined ? {} : { model: config.model }),
      },
      config.signal === undefined ? undefined : { signal: config.signal },
    );
  } catch (error) {
    handleRequestError(ctx, config, error);
    return;
  }
  const latencyMs = Date.now() - startedAt;

  // 200 でも中身が違うことがある。成功として扱う前に形を確かめる。
  const parsed = ResponseSchema.safeParse(result);
  if (!parsed.success) {
    addUnavailable(ctx, config.messages, [], "malformed_response", {});
    return;
  }

  config.onResponse?.({
    model: parsed.data.model,
    inputTokens: parsed.data.usage?.input_tokens ?? 0,
    outputTokens: parsed.data.usage?.output_tokens ?? 0,
    latencyMs,
    questionCount: group.targets.length,
  });

  for (const target of group.targets) {
    const answer = parsed.data.answers[target.key];
    if (answer === undefined) {
      // 回答が欠けた条件を黙って通さない。ここは条件違反ではなく「判定不能」。
      addUnavailable(ctx, config.messages, target.path, "malformed_response", {
        questionId: target.key,
      });
      continue;
    }

    const { threshold, id, message, uncertainMessage } = target.check;
    const probability = answer.noul;
    if (probability >= threshold) continue;

    // 同じ閾値を真偽の両側に当て、中間は判断保留にする。
    const kind = probability <= 1 - threshold ? ("rejected" as const) : ("uncertain" as const);
    ctx.addIssue({
      code: "custom",
      path: [...target.path],
      message:
        kind === "rejected"
          ? message
          : (uncertainMessage ?? config.messages.uncertain({ ...target.check })),
      params: {
        semantic: { kind, ruleId: id, probability, threshold },
      },
    });
  }
}

/** 通信・応答の失敗を issue に落とす。判断できないことを「合格」にしないための経路。 */
function handleRequestError(
  ctx: IssueContext,
  config: JudgeConfig,
  error: unknown,
): void {
  // 呼び出し側のキャンセルは検証結果ではなく制御フローなので、そのまま投げ直す。
  if (error instanceof APIUserAbortError) throw error;

  if (error instanceof APITimeoutError) {
    addUnavailable(ctx, config.messages, [], "timeout", {});
    return;
  }
  if (error instanceof APIConnectionError) {
    addUnavailable(ctx, config.messages, [], "network", {});
    return;
  }
  if (error instanceof APIError) {
    // SDK がリトライ済みの一時的な失敗は、判定不能として扱う。
    if (isTransient(error.status)) {
      addUnavailable(ctx, config.messages, [], "http", { status: error.status });
      return;
    }
    // リトライで直らない 4xx は設定・権限・要求の誤り。既定では例外にする。
    if (config.onClientError === "throw") throw error;
    addUnavailable(ctx, config.messages, [], "http", { status: error.status });
    return;
  }

  // 想定外の例外。メッセージは載せない（内部情報や機密が混ざり得るため）。
  addUnavailable(ctx, config.messages, [], "unknown", {});
}

const isTransient = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

/** 値が JSON に落ちないことを表す issue を足す（`toJSON` 未指定の `Date` など）。 */
export function addNotJson(ctx: IssueContext, messages: JevMessages): void {
  addUnavailable(ctx, messages, [], "not_json", {});
}

function addUnavailable(
  ctx: IssueContext,
  messages: JevMessages,
  path: readonly (string | number)[],
  reason: JevUnavailableReason,
  info: Omit<JevUnavailableContext, "reason">,
): void {
  const context: JevUnavailableContext = { reason, ...info };
  ctx.addIssue({
    code: "custom",
    path: [...path],
    message: messages.unavailable(context),
    params: {
      semantic: {
        kind: "unavailable",
        reason,
        ...(info.status === undefined ? {} : { status: info.status }),
      },
    },
  });
}
