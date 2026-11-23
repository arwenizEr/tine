# Contributing to tine

Thanks for helping. tine is a small terminal with a narrow job: run coding agents and review their changes on one screen. Changes that keep it small and fast are the easiest to accept.

## Before you start

- **Bugs:** open an issue with the steps to reproduce, your OS and tine version.
- **Features:** open an issue first and describe the problem it solves. Some things are out of scope on purpose: built-in AI, accounts, telemetry, git writes (commit, stage, checkout) and a plugin system.
- **Security issues:** do not open a public issue; see [SECURITY.md](SECURITY.md).

## Setup

You need Rust (stable), Node.js 22 or later, and on Linux the WebKitGTK packages from [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev
```

The [README](README.md#development) explains the layout: `ui/` is the interface, `core/` the Rust engine, and they talk only through `ui/ipc.ts` ↔ `core/src/lib.rs`.

## Pull requests

1. Branch from `main` and keep the change focused: one fix or feature per pull request.
2. Add tests: a Rust test for every new or changed command, and a `*.test.ts` file for pure frontend logic.
3. Run the checks; the pull request is not reviewed until they pass:

   ```sh
   npm run typecheck && npm test
   cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
   ```

4. Test on the platform you changed. Say in the pull request what you tested by hand.
5. Ask before adding a dependency, and say what it replaces. No frontend frameworks or new build tools.

## Code style

- TypeScript: plain DOM, shared state through `ui/state/` signals, each panel a module with `mount` and a dispose function.
- Rust: `cargo fmt`, no `unwrap` on input from the frontend or the file system; return an `AppError` instead.
- Comments say why, not what. Keep them short.

By contributing you agree that your work is released under the [MIT License](LICENSE).
