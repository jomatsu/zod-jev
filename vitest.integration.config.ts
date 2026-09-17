import { defineConfig } from "vitest/config";

// 実 API を叩く。`TYPESAFE_API_KEY`（または .env）が必要。
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.ts"],
    setupFiles: ["test/integration/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 課金とレート制限を避けるため直列で回す。
    fileParallelism: false,
  },
});
