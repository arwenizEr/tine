# tine

A lightweight desktop terminal for working with coding agents on one screen. Run Claude Code, Codex or any CLI in the terminal, and review what it changes without opening an IDE: a file tree that follows your shell, a code viewer with light editing, and a live git panel with diffs.

macOS and Linux. Built on Tauri 2, xterm.js and CodeMirror 6 with a Rust core; the installer is under 20 MB.

<!-- Screenshots: add images to docs/ and link them here before the first public release. -->

## What it does

- **A real terminal.** Tabs, true colour, Unicode, full-screen programs (vim, htop), Option as Meta, bracketed paste, Shift+Enter for a newline in agent prompts, clickable links and file paths.
- **Follows your shell.** The file tree roots itself at the active tab's folder (the git root inside a repo) and updates as files change.
- **Preview by selecting.** Click or arrow through the tree to preview code, images, Markdown or folder contents; Space opens a Quick Look overlay.
- **Light editing.** Double-click to open a file, type, Cmd+S. Saving never overwrites a change an agent made meanwhile: you get a bar to reload or keep your edits.
- **Review changes.** The Changes panel lists every changed file with line counts and shows its diff, unified or side by side, live while an agent works. **This Turn** narrows it to what changed since your last Enter.
- **Command blocks.** Each command gets a separator with its exit code and duration; Cmd+Up and Cmd+Down jump between them.
- **Made for agents.** Tabs show a spinner while a program works and a dot when it finishes or rings the bell; a desktop notification appears when tine is in the background. **Follow** mode shows each file's diff as the agent edits it.
- **Small screens.** Below 1100 px wide the viewer becomes a drawer over the terminal.

tine has no built-in AI, no account, no telemetry and makes no network calls of its own.

## Install

Download the latest build from [Releases](../../releases):

- **macOS:** `tine_<version>_universal.dmg` (Apple Silicon and Intel). The build is not notarized, so the first time, right-click tine.app and choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/tine.app`.
- **Linux:** `tine_<version>_amd64.AppImage` (make it executable and run it) or `tine_<version>_amd64.deb` (`sudo apt install ./tine_<version>_amd64.deb`).

## Build from source

Needs Rust (stable), Node.js 22 or later, and on macOS the Xcode Command Line Tools. On Linux, install the WebKitGTK build dependencies listed in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev    # run in development, reloading on frontend changes
npm run app          # build the app bundle into src-tauri/target/release/bundle/
```

**macOS: keep permissions across rebuilds.** macOS ties folder permissions (Desktop, Documents, Downloads) to an app's signature, and a locally built app gets a new one each time, so macOS asks again after every rebuild. Run this once to create a personal code-signing certificate in your own keychain; `npm run app` then signs with it and the permissions stick:

```sh
sh scripts/macos-signing.sh
```

It asks for your password to trust the certificate and to let `codesign` use it without prompting. To undo, delete "tine local signing" in Keychain Access.

## Settings

`~/.config/tine/settings.toml`, created with every option commented out on first start. Changes apply when you save. Open it from the command palette: Cmd+P, then `> Open Settings`.

```toml
font_family = "JetBrains Mono, Menlo, monospace"
font_size = 14
theme = "system"        # or "light", "dark"
shell = "/bin/zsh"      # default: your login shell

[keybindings]
newTab = "cmd+t"
palette = "cmd+shift+p"
clear = "none"          # unbind
```

## Keyboard shortcuts

On Linux, use Ctrl+Shift wherever macOS uses Cmd; Ctrl alone always goes to the shell.

| Shortcut | Action |
| --- | --- |
| Cmd+T / Cmd+W | New tab / close tab (or the open file, when the viewer has focus) |
| Cmd+1 … Cmd+9 | Go to tab |
| Cmd+K | Clear the terminal |
| Cmd+F | Find in the terminal (in the editor: find in the file) |
| Cmd+Up / Cmd+Down | Previous / next command block |
| Cmd+P | Command palette: open a file, or `>` for commands |
| Cmd+B / Cmd+J | Toggle the file tree / the viewer |
| Cmd+N / Cmd+O | New file in the current folder / open a folder in a new tab |
| Cmd+S | Save the open file |
| Shift+Enter | Newline in agent prompts (Claude Code, Codex) |
| Cmd+click | Open a file path printed in the terminal, at its line |
| Space | Quick Look the selected file in the tree |
| Cmd+Backspace | Move the selected tree item to the Trash |

Double-clicking a folder in the tree also `cd`s the active tab there, when its shell is idle at the prompt.

## Shell integration

For zsh and bash, tine injects a small script at start (through `ZDOTDIR` or `--rcfile`) that loads your own config first and never edits your dotfiles. It reports the working directory (OSC 7) and command boundaries (OSC 133), which drive the file tree, command blocks and `cd` from the tree. Other shells work as a plain terminal.

## Development

```sh
npm run typecheck && npm test                          # TypeScript and frontend unit tests
cd src-tauri && cargo clippy --all-targets && cargo test   # Rust core, against real shells and temporary git repos
```

`PLAN.md` is the design document: architecture, the IPC contract between the frontend and the Rust core, milestones and the list of ideas.

## License

<!-- Pending the owner's choice; see "Open decisions" in PLAN.md. -->
