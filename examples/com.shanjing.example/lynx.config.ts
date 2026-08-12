import { defineConfig } from "@lynx-js/rspeedy";
import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";

export default defineConfig({
  source: {
    entry: {
      main: "./src/index.tsx",
    },
  },
  plugins: [
    pluginReactLynx({
      engineVersion: "3.5",
      firstScreenSyncTiming: "immediately",
    }),
  ],
  output: {
    filename: {
      bundle: "[name].bundle",
    },
  },
});
