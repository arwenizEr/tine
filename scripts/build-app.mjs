// Builds the app bundle (`npm run app`). On macOS it signs with "<name> local signing" when
// scripts/macos-signing.sh has created that certificate, so macOS keeps privacy permissions
// across rebuilds; otherwise the build is ad-hoc signed. An APPLE_SIGNING_IDENTITY already in
// the environment always wins.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { productName } = JSON.parse(readFileSync("core/tauri.conf.json", "utf8"));
const env = { ...process.env };
const args = ["tauri", "build"];

if (process.platform === "darwin") {
  args.push("--bundles", "app");
  const name = `${productName} local signing`;
  if (!env.APPLE_SIGNING_IDENTITY) {
    const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    if (identities.includes(`"${name}"`)) {
      env.APPLE_SIGNING_IDENTITY = name;
      console.log(`Signing with "${name}".`);
    } else {
      console.warn(
        `No "${name}" certificate, so this build is ad-hoc signed and macOS will ask for folder access again.\n` +
          `Run once to fix that: sh scripts/macos-signing.sh`,
      );
    }
  }
}

const result = spawnSync("npx", args, { stdio: "inherit", env });
process.exit(result.status ?? 1);
