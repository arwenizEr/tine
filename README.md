<div align="center">

<img src="docs/logo.svg" width="128" height="128" alt="tine logo">

# tine

**A lightweight terminal for working with AI coding agents on one screen.**

Run Claude Code, Codex or any CLI, and review what it changes as it works: no IDE, no extra windows.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey.svg)
![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg)

[Install](#install) · [Features](#features) · [Shortcuts](#keyboard-shortcuts) · [Settings](#settings) · [Build from source](#build-from-source)

</div>

<!-- Screenshots: add images to docs/ and link them here before the first public release. -->

## Why tine

Coding agents edit files while you watch a terminal. To see what they did, you usually switch to an editor or run `git diff` by hand. tine puts the three things you need side by side, sized for a single laptop screen:

| Terminal | File tree | Viewer and changes |
| --- | --- | --- |
| A fast, full terminal where the agent runs | Follows your shell's folder and marks changed files | Live diffs of what the agent touched, and light editing |

It stays small: a Rust core with the system webview, an installer under 20 MB, and no built-in AI, account, telemetry or network calls of its own.

## Features

### A real terminal
- Tabs, true colour, Unicode, GPU rendering with a fallback.
- **Split:** Cmd+D shows a second tab beside the current one, for two agents or an agent and a dev server.
- Full-screen programs (vim, htop, less), Option as Meta, bracketed paste.
- **Shift+Enter** inserts a newline in agent prompts (Claude Code, Codex).
- Clickable links, and clickable file paths that open at the right line.
- **Command blocks:** each command gets a separator with its exit code and duration; jump between them with Cmd+Up / Cmd+Down.

### Made for watching agents
- Tabs show a spinner while a program works, a dot when it finishes, and a pulsing amber dot when an agent is waiting for your permission.
- A desktop notification when a task finishes while tine is in the background.
- **Changes panel:** every changed file with line counts, and its diff, unified or side by side, updating live.
- **This Turn:** narrows the changes to what happened since your last Enter, so you review only the agent's latest step.
- **Follow mode:** opens each file's diff the moment the agent edits it.
- **Point the agent at code:** select lines in a file or diff and press Cmd+L; tine types `src/app.ts:12-18 ` into the terminal so you can add what to do with them.

For the dot and desktop notifications, the agent has to report to the terminal. In Claude Code, open `/config` and set notifications to an iTerm2 option (it sends OSC 9, which tine reads) or to the terminal bell.

### Files without an IDE
- The file tree roots itself at the active tab's folder (the git root inside a repo) and updates as files change.
- Select to preview code, images, Markdown or folders; Space for Quick Look.
- Double-click a file to edit it, Cmd+S to save. tine never overwrites a change an agent made meanwhile: you choose to reload or keep your edits.
- Double-click a folder to `cd` the terminal there; drag a file into the terminal to paste its path.
- Create, rename and move to Trash from the tree's context menu.
- **Search in files:** Cmd+Shift+F finds a text in every file git does not ignore and opens the match at its line.
- **Open in Editor:** hands the file to VS Code, Cursor or Zed at the cursor's line, for edits bigger than tine is for.

### Fits any screen
- Resizable panels, each of which can be hidden.
- Below 1100 px wide, the viewer becomes a drawer over the terminal.
- Light and dark themes that follow the system, or a fixed one.

## Install

Download the latest build from [Releases](../../releases).

**macOS** (Apple Silicon and Intel): `tine_<version>_universal.dmg`. Drag tine to Applications. The build is not notarized, so the first launch needs one confirmation: open tine, then choose **Open Anyway** in System Settings → Privacy & Security. Or run:

```sh
xattr -dr com.apple.quarantine /Applications/tine.app
```

On first start, tine offers to open **Full Disk Access** in System Settings. Turn tine on there once, and macOS stops asking separately for Desktop, Documents, Downloads and other folders, for tine and every command you run in it. You can also find it later in the command palette: `> Allow Full Disk Access`.

**Linux** (x86-64):

```sh
# AppImage
chmod +x tine_<version>_amd64.AppImage && ./tine_<version>_amd64.AppImage

# Debian / Ubuntu
sudo apt install ./tine_<version>_amd64.deb
```

## Keyboard shortcuts

On Linux, use Ctrl+Shift wherever macOS uses Cmd; Ctrl alone always goes to the shell.

| Shortcut | Action |
| --- | --- |
| Cmd+T / Cmd+W | New tab / close tab (or the open file, when the viewer has focus) |
| Cmd+1 … Cmd+9 | Go to tab |
| Cmd+D | Split: open a tab beside this one, or back to one tab |
| Cmd+P | Command palette: find a file, or type `>` for commands |
| Cmd+Shift+F | Search in files |
| Cmd+K | Clear the terminal |
| Cmd+F | Find in the terminal (in the editor: find in the file) |
| Cmd+Up / Cmd+Down | Previous / next command block |
| Cmd+B / Cmd+J | Toggle the file tree / the viewer |
| Cmd+N / Cmd+O | New file in the current folder / open a folder in a new tab |
| Cmd+S | Save the open file |
| Cmd+, | Settings |
| Shift+Enter | Newline in agent prompts |
| Cmd+L | Send the selected lines' location to the terminal (in the viewer) |
| Cmd+click | Open a file path printed in the terminal |
| Space | Quick Look the selected file |
| Cmd+Backspace | Move the selected file to the Trash |

Shortcuts can be changed in `settings.toml` (see [Settings](#settings)).

## Settings

Click **⚙ Settings** at the right end of the terminal tabs (or press Cmd+,) to pick the font, font size, theme, shell and editor. Changes apply at once.

Everything is stored in `~/.config/tine/settings.toml`, which is created on first start with every option commented out. Shortcuts are changed only there. Open it from the settings window, or with Cmd+P → `> Open Settings File`; saved edits apply at once.

```toml
font_family = "JetBrains Mono, Menlo, monospace"
font_size = 14
theme = "system"        # "system", "light" or "dark"
shell = "/bin/zsh"      # default: your login shell
editor = "cursor"       # for Open in Editor: "vscode" (default), "cursor" or "zed"

[keybindings]
newTab = "cmd+t"
palette = "cmd+shift+p"
clear = "none"          # "none" removes a shortcut
```

## Shell integration

For zsh and bash, tine loads a small script at start (through `ZDOTDIR` or `--rcfile`). It runs your own config first and never edits your dotfiles. It reports the working directory (OSC 7) and command boundaries (OSC 133), which drive the file tree, command blocks and `cd` from the tree. Other shells work as a plain terminal without these extras.

## Build from source

Requirements:

- Rust (stable) and Node.js 22 or later
- macOS: Xcode Command Line Tools
- Linux: the WebKitGTK packages from [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm install
npm run tauri dev    # development build, reloads on frontend changes
npm run app          # release bundle in core/target/release/bundle/
```

### Tests

```sh
npm run typecheck && npm test                                # frontend
cd core && cargo clippy --all-targets && cargo test          # Rust core, against real shells and temporary git repos
```

### Architecture

| Layer | Technology |
| --- | --- |
| App shell | Tauri 2 with the system webview |
| Core | Rust: `portable-pty` for terminals, `git2` for status and diffs, `notify` for file watching |
| Terminal | xterm.js with the WebGL renderer |
| Editor and diffs | CodeMirror 6 with `@codemirror/merge` |
| UI | Plain TypeScript and CSS, bundled with esbuild, no framework |

The git panel is read-only by design: tine shows what changed and leaves committing to you and your tools.

### Project layout

Two folders, named for what they hold. They talk only through the commands in `ui/ipc.ts` ↔ `core/src/lib.rs`.

```text
ui/                     interface, TypeScript (runs in the system webview)
├── main.ts  app.ts     entry; layout, shortcuts, command palette, settings
├── ipc.ts              the only file that calls the core
├── keys.ts  paths.ts   shortcuts and path helpers, unit tested (*.test.ts)
├── terminal/           tabs, split, command blocks, search
├── filetree/           file tree that follows the shell
├── git/                Changes panel, This Turn, Follow
├── viewer/             file, image, Markdown and diff views, Quick Look
├── palette/            command palette
├── components/         menus, dialogs, toasts, settings window
├── state/              shared state (signals)
└── styles/             theme colours and layout
core/                   engine, Rust (a Tauri app; found by its tauri.conf.json)
├── src/                PTYs, files, git, watching, settings
├── shell-integration/  zsh and bash scripts that report folder and commands
├── tauri.conf.json     window, security policy, bundling
└── icons/              app icons, generated from docs/logo.svg
scripts/                build and signing helpers
docs/                   logo
```

## Contributing

Issues and pull requests are welcome. Run the tests above before opening a pull request and keep each change focused. For a larger feature, open an issue first so we can agree on the approach: tine aims to stay small.

## License

[MIT](LICENSE) © arwenizEr
