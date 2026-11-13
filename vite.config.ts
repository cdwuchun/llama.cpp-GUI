import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口，且失败即退出（strictPort）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/tmp/**"] },
  },
  build: {
    // Tauri 使用 WebView2（Chromium），可安全使用较新的目标
    target: "chrome110",
    sourcemap: false,
    outDir: "dist",
  },
  worker: {
    // chatDocs.ts 用 `new Worker(new URL("./chatDocs.worker.ts", import.meta.url), { type: "module" })`
    // 引入解析 worker。Vite 默认把 worker 打成 iife，而 iife 不支持 code splitting
    // （worker 里还动态 import 了 pdfjs/jszip），构建会直接报
    // "Invalid value \"iife\" for option \"worker.format\""。模块 worker 走 ES 输出即可；
    // WebView2 是 Chromium，支持 module worker。
    format: "es",
  },
});
