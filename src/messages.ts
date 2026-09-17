import type { JevMessages } from "./types.js";

/**
 * 既定メッセージ。表示言語は日本語、Jev に送る `instructions` は英語にしてある
 * （モデル向けの指示と、開発者・利用者が読むメッセージを分けている）。
 */
export const defaultMessages: JevMessages = {
  uncertain: (rule) =>
    `条件「${rule.id}」を満たすか確信が持てません。確認が必要です。`,

  unavailable: (info) => {
    switch (info.reason) {
      case "timeout":
        return "意味検証を完了できませんでした（タイムアウト）。再試行または確認が必要です。";
      case "network":
        return "意味検証を完了できませんでした（接続エラー）。再試行または確認が必要です。";
      case "http":
        return `意味検証を完了できませんでした（HTTP ${info.status ?? "?"}）。再試行または確認が必要です。`;
      case "not_json":
        return "意味検証の対象を JSON に変換できませんでした。JSON 化できない型には options.toJSON を指定してください。";
      case "state_too_large":
        return `意味検証の対象が大きすぎます（${info.characters ?? "?"} 文字 > 上限 ${info.maxCharacters ?? "?"} 文字）。`;
      case "malformed_response":
        return info.questionId === undefined
          ? "意味検証の応答を解釈できませんでした。"
          : `意味検証の応答に質問「${info.questionId}」の回答がありませんでした。`;
      default:
        return "意味検証を完了できませんでした。再試行または確認が必要です。";
    }
  },
};

/** 既定を土台に、指定されたぶんだけ差し替える。 */
export function resolveMessages(overrides?: Partial<JevMessages>): JevMessages {
  return { ...defaultMessages, ...overrides };
}
