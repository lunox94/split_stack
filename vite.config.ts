import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { buildXDC, eruda, mockWebxdc } from "@webxdc/vite-plugins";

function copyReleaseNotices(): Plugin {
  return {
    name: "split-stack-release-notices",
    apply: "build",
    writeBundle(outputOptions) {
      const outputDirectory = resolve(outputOptions.dir ?? "dist");
      copyFileSync(resolve("LICENSE"), resolve(outputDirectory, "LICENSE"));
      copyFileSync(
        resolve("THIRD_PARTY_NOTICES.md"),
        resolve(outputDirectory, "THIRD_PARTY_NOTICES.md"),
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    copyReleaseNotices(),
    buildXDC({
      outDir: "dist-xdc",
      outFileName: "split-stack.xdc",
      done: (error) => {
        if (error !== undefined) throw error;
      },
      filter: (fileName, _filePath, isDirectory) =>
        isDirectory ||
        (fileName !== "webxdc.js" &&
          !fileName.endsWith(".map") &&
          !fileName.endsWith("~")),
    }),
    // The upstream plugin injects only into explicit non-production debug
    // builds; normal production archives remain free of developer tooling.
    eruda(),
    ...(command === "serve" ? [mockWebxdc()] : []),
  ],
  build: {
    target: "es2017",
    sourcemap: false,
    assetsInlineLimit: 0,
    outDir: "dist",
  },
}));
