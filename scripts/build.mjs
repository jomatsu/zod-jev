#!/usr/bin/env node
// ESM と CJS を tsc で二回ビルドし、それぞれのディレクトリに package.json を置いて
// `"type"` の解釈を固定する。追加のバンドラ依存を持たないための小さなビルド手順。
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const tsc = "./node_modules/typescript/bin/tsc";

rmSync("dist", { recursive: true, force: true });

for (const [project, type] of [
  ["tsconfig.build.esm.json", "module"],
  ["tsconfig.build.cjs.json", "commonjs"],
]) {
  execFileSync(process.execPath, [tsc, "-p", project], { stdio: "inherit" });
  const out = project.includes("esm") ? "dist/esm" : "dist/cjs";
  writeFileSync(`${out}/package.json`, `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log("built dist/esm and dist/cjs");
