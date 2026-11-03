import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const backendTarget = process.env.VITE_OPENHARNESS_URL || "http://127.0.0.1:4096";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@openharness/sdk": path.resolve(__dirname, "./packages/sdk/src/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/v1": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/health": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/preview": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
