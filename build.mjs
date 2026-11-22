// Bundles src/main.ts (and the CSS it imports) into dist/. `--watch` rebuilds on change.
import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await mkdir("dist", { recursive: true });
// shortcut: index.html is copied once per start, restart `npm run tauri dev` after editing it.
await copyFile("index.html", "dist/index.html");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
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
