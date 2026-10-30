import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

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
  },
});
