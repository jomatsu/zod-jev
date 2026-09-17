import * as Z from "zod";

/**
 * Jev の `state` / `instructions` / `context` に載せられる値。
 * JSON に落ちない値（`Date`、`Map`、`undefined`、関数…）はここで弾く。
 */
export const JevJsonSchema = Z.json();

/**
 * `POST /v1/systemone` の応答のうち、判定に必要な部分だけを検証する。
 *
 * 公式 SDK は応答本文を JSON パースするだけで形を検査しないため、
 * 「200 だが中身が違う」応答を成功として扱わないようにここで確かめる。
 * `usage` は課金情報なので、欠けていても判定自体は続ける。
 */
export const ResponseSchema = Z.object({
  model: Z.string(),
  answers: Z.record(
    Z.string(),
    Z.object({
      type: Z.literal("noul"),
      noul: Z.number().min(0).max(1),
    }),
  ),
  usage: Z
    .object({
      input_tokens: Z.number().int().nonnegative(),
      output_tokens: Z.number().int().nonnegative(),
    })
    .optional(),
});

export type JevResponse = Z.output<typeof ResponseSchema>;
