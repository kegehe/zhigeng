import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 固定端口：Tauri 的 devUrl 指向它，被占用时直接失败而不是换个端口蒙混
// 1420 是 Tauri 社区惯例端口，但本机 Milevia 项目占着它；
// strictPort 会直接失败而不是静默换端口——写死一个不冲突的值，避免两个项目在开发时抢端口。
const PORT = 1425;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    // 必须显式绑 IPv4：Vite 默认 host 是 "localhost"，在本机解析成 ::1，
    // 而 tauri.conf 的 devUrl 指向 127.0.0.1 —— 不写这行壳会白屏。
    host: "127.0.0.1",
    port: PORT,
    strictPort: true,
    // outputs/ 是设计产物目录（图标方案、mockup HTML）：写它不该触发应用整页 reload
    watch: { ignored: ["**/src-tauri/**", "**/.scratch/**", "**/target/**", "**/outputs/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: mode !== "production",
  },
}));
