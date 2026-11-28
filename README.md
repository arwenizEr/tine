<div align="center">

<img src="docs/logo.svg" width="112" height="112" alt="tine logo">

# tine

**The terminal for working with AI coding agents.**

Run Claude Code, Codex or any CLI agent and review its changes live, on one screen.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey.svg)
![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg)

<img src="docs/screenshot.png" alt="tine with an agent's changes, the terminal and a diff side by side" width="100%">

</div>

## Features

- **Live changes:** every file the agent touches, with line counts and a unified or side-by-side diff.
- **This Turn / Branch:** only the changes since your last prompt, or everything since the branch left `main`.
- **Follow mode:** opens each diff as the agent writes it, without taking focus from the terminal.
- **Agent status:** tabs show when an agent is working, done, or waiting for your permission.
- **Point at code:** select lines and press Cmd+L to send `path:12-18` to the agent.
- **Full terminal:** tabs, split view, command blocks, clickable paths, GPU rendering.
- **Files:** a tree that follows your shell, previews, light editing, search in files, Open in Editor (VS Code, Cursor, Zed).
- **Web panel:** docs, a dev server or a video in place of the viewer, with bookmarks.
- **Restricted tabs (macOS):** a shell where every tool works, but writes only to its folder and a private copy of your home, and cannot read your keys.
- **Isolated tabs:** a root shell in a throwaway Docker container that sees only its folder.

No built-in AI, account or telemetry. A Rust core on the system webview, under 20 MB.

## Install

Releases are not published yet; build from source:

```sh
git clone https://github.com/arwenizEr/tine && cd tine
npm install
npm run app            # bundle in core/target/release/bundle/
npm run install-app    # macOS: build and copy to /Applications
```

Requires Rust (stable), Node.js 22+, and Xcode Command Line Tools on macOS or the [WebKitGTK packages](https://v2.tauri.app/start/prerequisites/) on Linux.

On first start, macOS users can grant **Full Disk Access** once instead of approving each folder.

## Keyboard shortcuts

On Linux, use Ctrl+Shift instead of Cmd (search in files: Ctrl+Alt+F).

| Shortcut | Action |
| --- | --- |
| Cmd+T / Cmd+W | New / close tab |
| Cmd+D | Split view |
| Cmd+P | Command palette (`>` for commands) |
| Cmd+Shift+F | Search in files |
| Cmd+F | Find |
| Cmd+K | Clear terminal |
| Cmd+Up / Cmd+Down | Previous / next command |
| Cmd+B / Cmd+J | Toggle file tree / viewer |
| Cmd+L | Send selected lines to the terminal |
| Cmd+S | Save file |
| Cmd+, | Settings |
| Shift+Enter | Newline in agent prompts |

## Settings

Use **⚙ Settings** for font, size, theme, shell and editor. Everything, including shortcuts, is stored in `~/.config/tine/settings.toml`:

```toml
font_size = 14
theme = "system"                           # system, light, dark
editor = "cursor"                          # vscode, cursor, zed
bookmarks = ["https://www.youtube.com/"]

[keybindings]
palette = "cmd+shift+p"
```

## Restricted tabs

**New Restricted Tab** (in the command palette) opens a shell under the macOS sandbox, in the active tab's folder. Everything you run there runs inside the sandbox, the folder's `package.json` scripts, `Makefile` and hooks included, and every tool keeps working: git, npm, cargo, pip, Claude Code, Codex and the rest.

- **Own home.** `HOME` is a private copy of your home: your dotfiles and tool configs (`~/.config`, `~/.gitconfig`, `~/.claude`, `~/.cargo`, ...) are copied once as APFS clones, so tools find their settings and write their state without changing the real ones. Toolchains (`~/.rustup`, `~/.nvm`) and your visible folders are linked read-only; `~/.cache` and `~/Library/Caches` start empty. The copy lives in tine's app data (`sandbox-home`); **Reset Sandbox Home…** starts it over from your current home.
- **Writes** go only to the tab's folder, the private home and temp folders. In repos that existed when the tab opened, `.git/hooks` and `.git/config` stay read-only, because your normal git would run them later; repos made in the tab (`git init`, `clone`, `cargo new`) are its own.
- **Secrets** stay out: no `~/.ssh`, `~/.aws`, `~/.gnupg`, credential files, keychain, browser cookies, or Docker's VM. Tools that need your logins (`gh`, `claude`, `git push`) need `secrets = true`.
- **No way out** through `open`, AppleScript, `launchctl` or local sockets such as Docker's; `sudo` and other setuid programs do not run.
- It refuses to start in your home folder, its parents, `~/Library` or a hidden folder in your home.

```toml
[sandbox]
secrets = true                # keychain, ssh-agent, ~/.ssh, ~/.aws, ...: default false
network = false               # default true
local_ports = [3920]          # reachable on localhost even with network off: a docs server, a database
writable = ["~/data"]         # real folders writable besides the tab's
deny_read = ["~/secrets"]     # added to the built-in list
shared = [".pyenv"]           # linked read-only instead of copied, like ~/.rustup
folders = ["~/untrusted"]     # tabs opened here are always restricted
```

Tabs tine opens in a `folders` entry (new tab, split, Open Terminal Here, restore) are always restricted, and a normal tab that `cd`s into one is warned. **Reset Sandbox Home…** in the command palette deletes the private home, so the next restricted tab copies your current config.

This protects against mistakes and careless tools, not against code written to break out. Run a folder's files from a normal tab and they run outside the sandbox, so something a restricted tab wrote there can run unsandboxed later. Claude Code's own sandbox cannot start inside this one (macOS does not nest them); it does not need to, since every command Claude runs is already sandboxed.

## Isolated tabs

**New Isolated Tab (Docker)** runs `bash` as root in a new container (`debian:stable-slim` by default) that sees only the active tab's folder, at `/work`. Use it for code you do not trust: install anything, run anything. It needs a running Docker: Colima, OrbStack or Docker Desktop.

- No environment variables from your Mac reach the container, so no API keys or tokens either.
- `.git/hooks` and `.git/config` of the folder are read-only inside.
- `network = false` under `[sandbox]` cuts the network; `image = "..."` picks another image with bash.
- Closing the tab removes the container. Containers left by a crashed tine are removed when tine starts.
- What you install is gone when the tab closes.

The container is only as isolated as Docker's VM. Colima, for example, shares your whole home folder with its VM by default, so code that escapes the container could reach it. Limit the VM's `mounts` to your projects folder if that matters to you.

## Local docs (CompactAIO)

[CompactAIO](https://github.com/arwenizEr/compactaio) is a self-hosted docs server: API docs checked against each package's types, at the version your lockfile names. Point tine at your checkout (where you ran `npm run setup`):

```toml
[caio]
path = "~/projects/compactaio"
```

- **● Docs** in the tab bar shows whether it runs; click to start it (`docker compose up -d`) or to search.
- **Search Docs (Caio)…**: `zod: min length` searches zod at your project's version; without a prefix, everything. Results open in the viewer, each with its source and whether its example was verified.
- **Check Symbol in Docs (Caio)…**: `zod string` says whether that export exists in your version, with its signature.
- **Connect Caio to Agents** registers it as an MCP server with your agent CLIs (Claude Code today), in your home and in the private home of restricted tabs.
- **Index This Project in Caio** indexes the active folder's dependencies at their lockfile versions.
- Restricted tabs reach it even with `network = false`; nothing else on the network.

tine talks to it only on `127.0.0.1`. For lockfile versions over HTTP, set `CAIO_PROJECTS_DIR` in CompactAIO's `.env` to the folder that holds your projects.

## Security

tine makes no network requests of its own. Web pages cannot call into the app, and terminal output cannot fake shell events. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For larger changes, please open an issue first.

## License

[MIT](LICENSE)
