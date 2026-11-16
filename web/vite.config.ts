import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The API runs separately in development (npm run dev:server); /api/* is forwarded to it.
    // In production the server serves this app and the API from the same origin.
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3000" },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
