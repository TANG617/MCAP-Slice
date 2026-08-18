import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    exclude: ["**/.vscode-test/**", "**/dist/**", "**/node_modules/**"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
