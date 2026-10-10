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
});
