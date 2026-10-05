import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // talkinghead dynamically imports its language-specific lipsync modules
  // (e.g. `./lipsync-en.mjs`) with a non-statically-analyzable path; Vite's
  // dep optimizer mis-bundles it, leaving a broken reference in
  // node_modules/.vite/deps. Excluding it lets the browser load the
  // package's own ESM files directly instead.
  optimizeDeps: {
    exclude: ["@met4citizen/talkinghead"],
  },
});
