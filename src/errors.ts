/**
 * ライブラリの使い方の誤り（rule の重複、閾値の範囲外、JSON でない context など）を表す。
 * 入力データの検証結果ではなく開発側の設定ミスなので、issue ではなく例外として投げる。
 * `TypeError` を継承しているので、既存の `catch (e instanceof TypeError)` でも捕まる。
 */
export class JevConfigError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JevConfigError";
  }
}
