#!/usr/bin/env node
// ビルド成果物が ESM からも CJS からも読み込めることを確かめる。
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cjs = require("../dist/cjs/index.js");
const esm = await import(new URL("../dist/esm/index.js", import.meta.url));

const functions = ["createJevZod", "getSemanticIssues", "noul", "TypeSafeClient"];
const values = ["defaultMessages", "DEFAULT_THRESHOLD"];
const classes = ["JevConfigError", "AuthenticationError", "RateLimitError"];

for (const [name, mod] of [
  ["cjs", cjs],
  ["esm", esm],
]) {
  for (const key of functions) {
    assert.equal(typeof mod[key], "function", `${name}: ${key} が function ではない`);
  }
  for (const key of classes) {
    assert.equal(typeof mod[key], "function", `${name}: ${key} が class ではない`);
    assert.ok(mod[key].prototype instanceof Error || mod[key].prototype instanceof TypeError, `${name}: ${key} が Error ではない`);
  }
  for (const key of values) {
    assert.ok(mod[key] !== undefined, `${name}: ${key} が無い`);
  }
}

console.log("dist check passed (esm + cjs)");
