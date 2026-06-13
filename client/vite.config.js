import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/login": "http://127.0.0.1:3000",
      "/logout": "http://127.0.0.1:3000",
      "/files": "http://127.0.0.1:3000",
      "/folders": "http://127.0.0.1:3000",
      "/upload": "http://127.0.0.1:3000",
      "/download": "http://127.0.0.1:3000",
      "/preview": "http://127.0.0.1:3000",
      "/video": "http://127.0.0.1:3000",
      "/delete": "http://127.0.0.1:3000",
      "/items": "http://127.0.0.1:3000",
      "/storage": "http://127.0.0.1:3000",
      "/system-status": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
});
