// Bundles ui/main.ts (and the CSS it imports) into dist/. `--watch` rebuilds on change.
import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await mkdir("dist", { recursive: true });
// shortcut: ui/index.html is copied once per start, restart `npm run tauri dev` after editing it.
await copyFile("ui/index.html", "dist/index.html");

const ctx = await esbuild.context({
  entryPoints: ["ui/main.ts"],
  bundle: true,
  format: "esm",
  // Language packages load on demand, so each becomes its own chunk.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  outdir: "dist",
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
