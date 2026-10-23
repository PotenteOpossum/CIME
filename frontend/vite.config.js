import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const config = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react()],
    base: config.VITE_BASE_PATH || "/",
    server: {
      fs: { allow: ['.', '../shared'] },
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:4000",
        "/socket.io": { target: "http://127.0.0.1:4000", ws: true },
        "/admin": "http://127.0.0.1:5174",
      },
    },
  };
});
