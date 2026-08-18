import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/webview",
  base: "./",
  build: {
    outDir: "../../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/webview/index.html",
      output: {
        entryFileNames: "app.js",
        assetFileNames: "[name][extname]"
      }
    }
  }
});
