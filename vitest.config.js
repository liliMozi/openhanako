import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ".cache/**",
      "desktop/native/**/.build/**",
      "dist-computer-use/**",
    ],
    testTimeout: 10_000,
    setupFiles: ["./tests/setup-auto-updater.js"],
    server: {
      deps: {
        inline: ["electron-updater", /desktop\/auto-updater/],
      },
    },
  },
});
