import * as Z from "zod";
import type { SemanticIssueDetails } from "./types.js";

/** Zod の issue から取り出した意味検証の結果。 */
export interface SemanticIssue {
  /** ルートからのパス。`rule.path` と配列の添字が含まれる。 */
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly details: SemanticIssueDetails;
}

const DetailsSchema = Z.discriminatedUnion("kind", [
  Z.object({
    kind: Z.literal("rejected"),
    ruleId: Z.string(),
    probability: Z.number(),
    threshold: Z.number(),
  }),
  Z.object({
    kind: Z.literal("uncertain"),
    ruleId: Z.string(),
    probability: Z.number(),
    threshold: Z.number(),
  }),
  Z.object({
    kind: Z.literal("unavailable"),
    reason: Z.string(),
    status: Z.number().optional(),
  }),
]);

function readDetails(params: unknown): SemanticIssueDetails | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const parsed = DetailsSchema.safeParse((params as { semantic?: unknown }).semantic);
  return parsed.success ? (parsed.data as SemanticIssueDetails) : undefined;
}

/**
 * `safeParseAsync` の結果から、Jev の判定に由来する issue だけを取り出す。
 *
 * 形式エラー（Zod 自身の issue）と意味エラーを分けて扱いたいときに使う。
 * `unavailable` は「判定できなかった」であり、条件が成立したわけではない。
 */
export function getSemanticIssues(error: Z.ZodError): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  for (const issue of error.issues) {
    const details = readDetails("params" in issue ? issue.params : undefined);
    if (details === undefined) continue;
    issues.push({
      path: issue.path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      ),
      message: issue.message,
      details,
    });
  }
  return issues;
}
