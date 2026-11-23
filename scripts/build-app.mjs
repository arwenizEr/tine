// Builds the app bundle (`npm run app`; `npm run install-app` also copies it to /Applications). On macOS it signs with "<name> local signing" when
// scripts/macos-signing.sh has created that certificate, so macOS keeps privacy permissions
// across rebuilds; otherwise the build is ad-hoc signed. An APPLE_SIGNING_IDENTITY already in
// the environment always wins.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

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
if (result.status !== 0) process.exit(result.status ?? 1);

// `npm run install-app` (macOS): also put the app in /Applications, so a Dock icon keeps
// working whatever the build folder is called. ditto keeps the signature intact.
if (process.argv.includes("--install") && process.platform === "darwin") {
  const built = `core/target/release/bundle/macos/${productName}.app`;
  const installed = `/Applications/${productName}.app`;
  rmSync(installed, { recursive: true, force: true });
  execFileSync("ditto", [built, installed]);
  console.log(`Installed ${installed}`);
}
