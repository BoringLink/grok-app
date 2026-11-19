import { defineConfig, type Plugin } from "vite";
// SWC avoids Babel codegen deopt on large modules (AppWorkbench.tsx ~450KB).
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
import { resolveBakedDisplayVersion } from "./build-version";
import { vendorManualChunk } from "./src/lib/viteManualChunks";
import {
  isKatexFallbackFontAsset,
  stripKatexFallbackFontSrc,
} from "./src/lib/katexFontTrim";

const host = process.env.TAURI_DEV_HOST;
const root = path.resolve(__dirname);

// KaTeX ships woff2 + woff + ttf per font; the desktop WebViews all do
// woff2, so drop the fallback src entries and their assets (~700KB).
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "asset") continue;
        if (fileName.endsWith(".css")) {
          chunk.source = stripKatexFallbackFontSrc(String(chunk.source));
        } else if (isKatexFallbackFontAsset(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), katexWoff2Only()],
  define: {
    "import.meta.env.VITE_GROK_DISPLAY_VERSION": JSON.stringify(
      resolveBakedDisplayVersion(root),
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1422,
        }
      : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.grok-app-dev-home/**",
        "**/.cargo-home/**",
        "**/*.tsbuildinfo",
      ],
    },
  },
  build: {
    // Skip the gzip size report; it holds every chunk in memory again.
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks: vendorManualChunk,
      },
    },
  },
}));
