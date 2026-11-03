import { defineConfig } from "vite";

/**
 * Relative asset URLs: the desktop app serves the build from its own `app://` origin, and a development page, a copy
 * on a file share or a sub-path all work with the same bundle.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "chrome130",
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
});
