import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.BLIFT_API ?? "http://localhost:8787", changeOrigin: false },
      "/install.sh": { target: process.env.BLIFT_API ?? "http://localhost:8787", changeOrigin: false },
      // Share links: browsers get the app, wget and curl the API (see server/src/app.ts isSharePage).
      "/s/": {
        target: process.env.BLIFT_API ?? "http://localhost:8787",
        changeOrigin: false,
        bypass: (req) => (req.headers.accept?.includes("text/html") && /^\/s\/[^/]+\/?(\?|$)/.test(req.url ?? "") ? req.url : undefined),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
