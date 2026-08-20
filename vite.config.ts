import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  const apiOrigin = environment.VITE_API_ORIGIN || "http://127.0.0.1:8787";
  return {
    plugins: [react()],
    build: {
      outDir: "dist/web",
      emptyOutDir: true,
      sourcemap: mode !== "production",
      target: "es2022",
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
