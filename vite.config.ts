import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const consoleHost = process.env.MTC_CONSOLE_HOST || "127.0.0.1";
const apiHost = ["0.0.0.0", "::", "[::]"].includes(consoleHost) ? "127.0.0.1" : consoleHost;
const apiUrlHost = apiHost.includes(":") && !apiHost.startsWith("[") ? `[${apiHost}]` : apiHost;

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    host: consoleHost,
    port: Number(process.env.MTC_CONSOLE_WEB_PORT || 4311),
    proxy: {
      "/api/": `http://${apiUrlHost}:${process.env.MTC_CONSOLE_PORT || 4310}`,
    },
  },
});
