<div align="center">

<img src="docs/logo.svg" width="112" height="112" alt="tine logo">

# tine

**The terminal for working with AI coding agents.**

Run Claude Code, Codex or any CLI agent, and review every change it makes, live, on the same screen.<br>
No IDE, no extra windows, no account.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey.svg)
![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg)

[Features](#features) · [Install](#install) · [Shortcuts](#keyboard-shortcuts) · [Settings](#settings) · [Privacy](#privacy-and-security) · [Development](#development)

<br>

<img src="docs/screenshot.png" alt="tine: an agent's changes listed on the left, the agent running in the middle, and the diff of an edited file on the right" width="100%">

</div>

## Why tine

A coding agent edits files while you watch a terminal. To see what it actually did, you switch to an editor or run `git diff` by hand, and lose track of the agent while you do.

tine keeps the three things you need side by side, sized for one laptop screen:

- **The terminal** where the agent runs: a fast, complete terminal, not a chat box.
- **The changes**: every file the agent touched, with line counts, updating as it works.
- **The diff** of the file you pick, unified or side by side, with + and − on each line.

It stays out of the way: a small Rust core on the system webview, an app under 20 MB, and no built-in AI, telemetry or network calls of its own.

## Features

### Review what the agent did

| | |
| --- | --- |
| **Changes panel** | Every changed file with +/− counts and its diff, live. Read-only by design: committing stays with you. |
| **This Turn** | Only what changed since your last Enter, so you review one agent step at a time. |
| **Branch** | Everything the branch changed since it left `main`: commits and uncommitted edits in one list. |
| **Follow mode** | Opens each file's diff the moment the agent writes it, without taking focus from the terminal. |
| **Cmd+L** | Select lines in a file or diff and tine types `src/app.ts:12-18 ` into the agent's prompt. |

### Keep an eye on several agents

- Tabs show a spinner while a program works, a dot when it finishes, and a pulsing amber dot when an agent waits for your permission.
- A desktop notification when a task finishes while tine is in the background.
- **Split** (Cmd+D) puts two tabs side by side: two agents, or an agent and a dev server.

The waiting dot and notifications need the agent to report to the terminal. In Claude Code, open `/config` and set notifications to an iTerm2 option (it sends OSC 9, which tine reads) or to the terminal bell.

### A real terminal

- Tabs, true colour, Unicode and GPU rendering, with a fallback.
- Full-screen programs (vim, htop, less), Option as Meta, bracketed paste, and **Shift+Enter** for newlines in agent prompts.
- **Command blocks:** each command gets a separator with its exit code and duration; Cmd+Up / Cmd+Down jump between them.
- Clickable links, and file paths that open in the viewer at the right line.

### Files, without an IDE

- A file tree that follows the active tab's folder (the git root inside a repo) and marks changed files.
- Preview code, images, Markdown and folders; Space for Quick Look.
- Light editing with Cmd+S. tine never overwrites a change an agent made in the meantime: you choose to reload or keep yours.
- **Search in files** (Cmd+Shift+F) across everything git does not ignore.
- **Open in Editor** hands the file to VS Code, Cursor or Zed at the cursor's line.
- Double-click a folder to `cd` there; drag a file into the terminal to paste its path; create, rename and trash from the tree.

### A web panel for the wait

**◫ Web** swaps the viewer for a web page: docs, your dev server, or a video while the agent works. Keep bookmarks with ☆, and switch back with **‹ Files** while the page keeps playing. Pages run in their own webview with no access to tine.

### Fits your screen

Every panel can be resized or hidden. Below 1100 px wide the viewer becomes a drawer over the terminal. Light and dark themes follow the system, or pick one.

## Install

Pre-built downloads will be published on the [Releases](../../releases) page. Until the first release, [build from source](#development); it takes two commands.

**macOS** (Apple Silicon and Intel): open the `.dmg` and drag tine to Applications. The build is not notarized, so the first launch needs one confirmation in System Settings → Privacy & Security → **Open Anyway**, or:

```sh
xattr -dr com.apple.quarantine /Applications/tine.app
```

On first start tine offers to open **Full Disk Access**. Turn it on once and macOS stops asking separately for Desktop, Documents and Downloads, for tine and every command you run in it.

**Linux** (x86-64):

```sh
chmod +x tine_<version>_amd64.AppImage && ./tine_<version>_amd64.AppImage   # AppImage
sudo apt install ./tine_<version>_amd64.deb                                  # Debian / Ubuntu
```

## Keyboard shortcuts

On Linux, use Ctrl+Shift where macOS uses Cmd (search in files is Ctrl+Alt+F). Ctrl alone always goes to the shell.

| Shortcut | Action |
| --- | --- |
| Cmd+T / Cmd+W | New tab / close tab (or the open file, when the viewer has focus) |
| Cmd+1 … Cmd+9 | Go to tab |
| Cmd+D | Split: a second tab beside this one, or back to one |
| Cmd+P | Command palette: find a file, or type `>` for commands |
| Cmd+Shift+F | Search in files |
| Cmd+F | Find in the terminal (in the editor: in the file) |
| Cmd+K | Clear the terminal |
| Cmd+Up / Cmd+Down | Previous / next command block |
| Cmd+B / Cmd+J | Toggle the file tree / the viewer |
| Cmd+N / Cmd+O | New file here / open a folder in a new tab |
| Cmd+S | Save the open file |
| Cmd+L | Send the selected lines' location to the terminal |
| Cmd+, | Settings |
| Shift+Enter | Newline in agent prompts |
| Cmd+click | Open a file path printed in the terminal |
| Space | Quick Look the selected file |
| Cmd+Backspace | Move the selected file to the Trash |

## Settings

Click **⚙ Settings** at the right of the terminal tabs (or press Cmd+,) to pick the font, size, theme, shell and editor from lists. Changes apply at once.

Everything lives in `~/.config/tine/settings.toml`, created on first start with every option commented out. Shortcuts are changed only there (Cmd+P → `> Open Settings File`); saved edits apply at once.

```toml
font_family = "JetBrains Mono, Menlo, monospace"
font_size = 14
theme = "system"                           # "system", "light" or "dark"
shell = "/bin/zsh"                         # default: your login shell
editor = "cursor"                          # "vscode" (default), "cursor" or "zed"
bookmarks = ["https://www.youtube.com/"]   # the web panel's ☆ adds to this

[keybindings]
newTab = "cmd+t"
palette = "cmd+shift+p"
clear = "none"                             # "none" removes a shortcut
```

## Privacy and security

- **No network calls of its own.** No telemetry, no update checks, no account. The only traffic is what your commands make and the pages you open in the web panel.
- **Web pages are isolated.** The web panel is a separate webview; tine's commands accept calls only from its own interface, never from a remote page.
- **Terminal output cannot drive the app.** Shell integration marks are signed with a per-tab secret, so a program printing escape codes cannot fake a prompt or a finished command. Links open only for `http`, `https` and `mailto`.
- **Your dotfiles stay untouched.** For zsh and bash, tine loads a small script through `ZDOTDIR` or `--rcfile` that runs your own config first. It reports the folder (OSC 7) and command boundaries (OSC 133), which drive the file tree and command blocks. Other shells work as a plain terminal.

Found a vulnerability? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## Development

You need Rust (stable) and Node.js 22 or later, plus Xcode Command Line Tools on macOS or the WebKitGTK packages from [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) on Linux.

```sh
npm install
npm run tauri dev     # development build, reloads on frontend changes
npm run app           # release bundle in core/target/release/bundle/
npm run install-app   # macOS: the same, then copied to /Applications
```

Before a pull request:

```sh
npm run typecheck && npm test                                 # frontend
cd core && cargo clippy --all-targets -- -D warnings && cargo test   # core, against real shells and git repos
```

### How it is built

| Layer | Technology |
| --- | --- |
| App shell | Tauri 2 on the system webview (WebKit on macOS, WebKitGTK on Linux) |
| Core | Rust: `portable-pty` for terminals, `git2` for status and diffs, `notify` for watching files |
| Terminal | xterm.js with the WebGL renderer |
| Editor and diffs | CodeMirror 6 with `@codemirror/merge` |
| Interface | Plain TypeScript and CSS, bundled with esbuild; no framework |

The interface and the core talk only through the commands in `ui/ipc.ts` ↔ `core/src/lib.rs`.

```text
ui/                     interface (TypeScript, runs in the webview)
├── main.ts  app.ts     entry; layout, shortcuts, command palette
├── ipc.ts              the only file that calls the core
├── terminal/           tabs, split, command blocks, find
├── filetree/           file tree that follows the shell
├── git/                Changes panel, This Turn, Branch, Follow
├── viewer/             file, image, Markdown and diff views, Quick Look
├── web/                web panel and bookmarks
├── palette/            command palette and search in files
├── components/         menus, dialogs, toasts, settings window
├── state/              shared state (signals)
└── styles/             theme colours and layout
core/                   engine (Rust, a Tauri app)
├── src/                PTYs, files, git, watching, settings
├── shell-integration/  zsh and bash scripts
└── tauri.conf.json     window, security policy, bundling
scripts/                build and signing helpers
```

## Contributing

Bug reports, ideas and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). tine aims to stay small, so for a larger feature please open an issue first.

## License

[MIT](LICENSE) © arwenizEr
