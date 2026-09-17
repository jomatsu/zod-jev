import { existsSync } from "node:fs";

// 実 API を叩くテストでは API キーが要る。`.env` があれば読み込む
// （Node 20.12+ の process.loadEnvFile。dotenv は使わない）。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
