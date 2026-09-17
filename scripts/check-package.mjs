#!/usr/bin/env node
// 公開パッケージを「消費者として」読み込めるかを確認する。
//
// npm pack で tarball を作って install する代わりに、リポジトリを node_modules/zod-jev として
// リンクし、package.json の exports マップ経由で解決させる（ESM / CJS の両方）。
// これで「ビルド成果物 + exports の設定」が公開後に動くかを確認できる。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, ".tmp", "consumer");

rmSync(join(root, ".tmp"), { recursive: true, force: true });
mkdirSync(join(tmp, "node_modules"), { recursive: true });

// 消費者の node_modules に、このリポジトリをパッケージとしてリンクする
symlinkSync(root, join(tmp, "node_modules", "zod-jev"), "dir");

writeFileSync(
  join(tmp, "package.json"),
  `${JSON.stringify({ name: "zod-jev-consumer-check", private: true, type: "module" }, null, 2)}\n`,
);

writeFileSync(
  join(tmp, "esm.mjs"),
  `import { createJevZod, getSemanticIssues, JevConfigError, RateLimitError } from "zod-jev";

const z = createJevZod({
  apiKey: "test-key",
  retry: { backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
  fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url !== "https://api.typesafe.ai/v1/systemone") throw new Error("unexpected url: " + url);
    if (body.model !== "jev-latest") throw new Error("unexpected model: " + body.model);
    if (Object.keys(body.questions).length !== 2) throw new Error("expected 2 questions");
    if (body.state.context.policy !== "no PII") throw new Error("context was not sent");
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { q0: { type: "noul", noul: 0.02 }, q1: { type: "noul", noul: 0.99 } },
        usage: { input_tokens: 120, output_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

const Checked = z.semantic(
  z.object({ body: z.string() }),
  [
    { id: "no_pii", is: "contains no personal data", message: "Remove personal data.", path: ["body"] },
    { id: "normal", is: "is an ordinary message", message: "Looks odd." },
  ],
  { context: { policy: "no PII" } },
);

const result = await Checked.safeParseAsync({ body: "call me on 090-1234-5678" });
if (result.success) throw new Error("expected the parse to fail");
const issues = getSemanticIssues(result.error);
if (issues.length !== 1) throw new Error("expected 1 issue, got " + issues.length);
if (issues[0].details.ruleId !== "no_pii" || issues[0].details.kind !== "rejected") {
  throw new Error("unexpected issue: " + JSON.stringify(issues[0]));
}
if (issues[0].path.join(".") !== "body") throw new Error("unexpected path");

if (typeof JevConfigError !== "function" || typeof RateLimitError !== "function") {
  throw new Error("error classes are not re-exported");
}
try {
  z.semantic(z.object({}), []);
  throw new Error("expected JevConfigError");
} catch (error) {
  if (!(error instanceof JevConfigError)) throw error;
}

console.log("ok (esm):", issues[0].details.kind, issues[0].details.ruleId, issues[0].details.probability);
`,
);

writeFileSync(
  join(tmp, "cjs.cjs"),
  `const { createJevZod, getSemanticIssues } = require("zod-jev");

const z = createJevZod({
  apiKey: "test-key",
  retry: { backoffInitialMs: 0 },
  fetch: async () =>
    new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { q0: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
});

const Checked = z.semantic(z.object({ body: z.string() }), [
  { id: "x", is: "is fine", message: "Not fine.", path: ["body"] },
]);

Checked.safeParseAsync({ body: "hello" }).then((result) => {
  if (result.success) throw new Error("expected failure");
  const issues = getSemanticIssues(result.error);
  if (issues[0].details.kind !== "uncertain") throw new Error("unexpected kind: " + issues[0].details.kind);
  console.log("ok (cjs):", issues[0].details.kind, issues[0].details.probability);
});
`,
);

for (const file of ["esm.mjs", "cjs.cjs"]) {
  execFileSync(process.execPath, [join(tmp, file)], { stdio: "inherit", cwd: tmp });
}

rmSync(join(root, ".tmp"), { recursive: true, force: true });
console.log("package check passed (exports map: esm + cjs)");
