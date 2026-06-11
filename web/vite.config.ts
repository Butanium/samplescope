import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dev-only config: the vite server proxies /api to a running samplescope
// API. Point it elsewhere with SAMPLESCOPE_API / WEB_PORT, e.g.
//   SAMPLESCOPE_API=http://127.0.0.1:8766 WEB_PORT=5180 npm run dev
const apiTarget = process.env.SAMPLESCOPE_API ?? "http://127.0.0.1:8765";
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: webPort,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
