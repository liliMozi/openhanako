import { SettingsManager } from "../lib/pi-sdk/index.js";

/** 默认 session settings（compaction 配置） */
export function createDefaultSettings() {
  return SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
    },
  });
}
