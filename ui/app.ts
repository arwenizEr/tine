import * as filetree from "./filetree/index.ts";
import { mountBadge } from "./git/badge.ts";
import { startFollow } from "./git/follow.ts";
import * as gitPanel from "./git/index.ts";
import { errorMessage, fsWatch, offerFullDiskAccess, onFsChanged, onMenu, openFullDiskAccessSettings, openInEditor, pickFolder, settingsLoad, type Settings } from "./ipc.ts";
import { buildKeymap, keyAction, type KeyAction, type Keymap } from "./keys.ts";
import { mountPalette } from "./palette/index.ts";
import { dirname, hasControlChars } from "./paths.ts";
import { commands } from "./state/commands.ts";
import { activeDocId, docs, openDoc, selected, treeRoot } from "./state/files.ts";
import { followMode, isCompact, sidebarVisible, viewerMode, viewerVisible } from "./state/layout.ts";
import { gitState, repo, sidebarView } from "./state/git.ts";
import { settings, settingsPath } from "./state/settings.ts";
import { activeCwd } from "./state/tabs.ts";
import * as terminal from "./terminal/index.ts";
import { watch } from "./signal.ts";
import { openSettings } from "./components/settings.ts";
import { toast } from "./components/toast.ts";
import * as viewer from "./viewer/index.ts";
import * as web from "./web/index.ts";
import * as quicklook from "./viewer/quicklook.ts";

const MIN_PANEL = 160;
const MIN_TERMINAL = 320;

/** A drag handle between two columns; `side` says which way dragging grows the panel. */
function resizer(panel: HTMLElement, side: 1 | -1): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "resizer";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.onpointerdown = (down) => {
    handle.setPointerCapture(down.pointerId);
    const startWidth = panel.getBoundingClientRect().width;
    handle.onpointermove = (move) => {
      const width = startWidth + side * (move.clientX - down.clientX);
      panel.style.width = `${Math.max(MIN_PANEL, Math.min(width, innerWidth - MIN_TERMINAL))}px`;
    };
    handle.onpointerup = () => {
      handle.onpointermove = null;
    };
  };
  return handle;
}

/** Sidebar switch between the file tree and the git panel; shown only inside a repo. */
function sidebarSwitch(parent: HTMLElement): () => void {
  const bar = document.createElement("div");
  bar.className = "sidebar-switch";
  bar.setAttribute("role", "tablist");
  const files = Object.assign(document.createElement("button"), { textContent: "Files" });
  const changes = document.createElement("button");
  for (const [b, view] of [[files, "files"], [changes, "git"]] as const) {
    b.setAttribute("role", "tab");
    b.onclick = () => sidebarView.set(view);
  }
  bar.append(files, changes);
  parent.append(bar);
  const render = () => {
    if (!repo.get() && sidebarView.get() === "git") sidebarView.set("files");
    const n = new Set(gitState.get()?.files.map((f) => f.path)).size;
    changes.textContent = n ? `Changes (${n})` : "Changes";
    // With one view there is nothing to switch: outside a repo the bar goes away entirely.
    bar.hidden = !repo.get();
    files.setAttribute("aria-selected", String(sidebarView.get() === "files"));
    changes.setAttribute("aria-selected", String(sidebarView.get() === "git"));
  };
  const unsubs = [repo.subscribe(render), gitState.subscribe(render), sidebarView.subscribe(render)];
  render();
  return () => {
    unsubs.forEach((u) => u());
    bar.remove();
  };
}

/** Layout: sidebar (file tree or git panel) | terminal | side panel (viewer), over a status bar. */
export function mountApp(root: HTMLElement): () => void {
  const workspace = document.createElement("div");
  workspace.className = "workspace";
  const statusBar = document.createElement("footer");
  statusBar.className = "statusbar";
  root.append(workspace, statusBar);

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  const filesView = document.createElement("div");
  filesView.className = "sidebar-view";
  const gitView = document.createElement("div");
  gitView.className = "sidebar-view";
  const main = document.createElement("main");
  main.className = "terminal-column";
  const side = document.createElement("section");
  side.className = "viewer";
  side.setAttribute("aria-label", "Viewer");
  const leftHandle = resizer(sidebar, 1);
  const rightHandle = resizer(side, -1);
  rightHandle.classList.add("viewer-handle");
  workspace.append(sidebar, leftHandle, main, rightHandle, side);

  const disposeSwitch = sidebarSwitch(sidebar);
  sidebar.append(filesView, gitView);
  const disposeTree = filetree.mount(filesView);
  const disposeGit = gitPanel.mount(gitView);
  const disposeBadge = mountBadge(statusBar, () => {
    sidebarView.set("git");
    sidebarVisible.set(true);
  });

  const follow = document.createElement("button");
  follow.className = "follow-toggle";
  follow.textContent = "Follow";
  follow.title = "Show each file's diff as it changes";
  follow.onclick = () => followMode.set(!followMode.get());
  statusBar.append(follow);
  const stopFollow = startFollow();

  // Compact layout: the viewer is a drawer. Clicking the terminal puts it away.
  main.addEventListener("mousedown", () => {
    if (isCompact()) viewerVisible.set(false);
  });
  const term = terminal.mount(main);
  // The viewer column shows either the open docs or the web panel.
  const docsArea = Object.assign(document.createElement("div"), { className: "viewer-docs" });
  side.append(docsArea);
  const disposeViewer = viewer.mount(docsArea);
  const disposeWeb = web.mount(side);
  const disposeQuickLook = quicklook.mount(root);

  const newFile = () => {
    const dir = activeCwd() ?? treeRoot.get();
    if (dir) void filetree.newFileIn(dir);
    else toast("No folder yet: wait for the shell prompt, then try again.");
  };
  const openFolder = async () => {
    const dir = await pickFolder();
    if (dir) commands.newTab(dir);
  };

  const openSettingsFile = () => {
    const path = settingsPath.get();
    if (path) openDoc(path, "file", { focus: true });
    else toast("Settings are not loaded yet.");
  };

  commands.openSettings = () => openSettings(openSettingsFile);

  const palette = mountPalette(root, () => [
    { label: "New Tab", run: () => term.newTab() },
    ...(["restricted", "isolated"] as const).map((kind) => ({
      label: kind === "restricted" ? "New Restricted Tab" : "New Isolated Tab (Docker)",
      run: () => {
        const dir = activeCwd() ?? treeRoot.get();
        if (dir) term.newTab(dir, kind);
        else toast("No folder yet: wait for the shell prompt, then try again.");
      },
    })),
    { label: "Close Tab", run: () => term.closeTab() },
    { label: "Split Terminal", run: () => term.split() },
    { label: "New File…", run: newFile },
    { label: "Open Folder…", run: () => void openFolder() },
    { label: "Toggle File Tree", run: () => sidebarVisible.set(!sidebarVisible.get()) },
    { label: "Toggle Viewer", run: () => viewerVisible.set(!viewerVisible.get()) },
    { label: "Show Changes", run: () => (sidebarView.set("git"), sidebarVisible.set(true)) },
    { label: "Toggle Follow Mode", run: () => followMode.set(!followMode.get()) },
    { label: "Find in Terminal", run: () => term.find() },
    { label: "Search in Files…", run: () => palette.open("search") },
    {
      label: "Open in Editor",
      run: () => {
        const doc = docs.get().find((d) => d.id === activeDocId.get());
        if (!doc || doc.kind === "dir") return toast("Open a file in the viewer first.");
        const at = viewer.cursorIn(doc.path);
        openInEditor(doc.path, at.line, at.col).catch((e) => toast(errorMessage(e)));
      },
    },
    { label: "Clear Terminal", run: () => term.clear() },
    ...(terminal.isMac ? [{ label: "Allow Full Disk Access…", run: () => void openFullDiskAccessSettings() }] : []),
    { label: "Toggle Web Panel", run: () => commands.toggleWeb() },
    { label: "Settings…", run: () => openSettings(openSettingsFile) },
    { label: "Open Settings File", run: openSettingsFile },
  ]);

  // Settings: applied now, and again every time the file is saved.
  let keymap: Keymap | undefined;
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const applySettings = (s: Settings) => {
    const html = document.documentElement;
    if (s.theme === "light" || s.theme === "dark") html.dataset.theme = s.theme;
    else delete html.dataset.theme;
    if (s.font_family) html.style.setProperty("--mono-font", s.font_family);
    else html.style.removeProperty("--mono-font");
    const built = buildKeymap(terminal.isMac, s.keybindings);
    keymap = built.keymap;
    for (const error of built.errors) toast(error);
    term.restyle();
  };
  const loadSettings = async () => {
    try {
      const { path, settings: s } = await settingsLoad();
      settingsPath.set(path);
      settings.set(s);
    } catch (e) {
      toast(`Settings not applied: ${errorMessage(e)}`);
    }
  };
  const unsubSettings = watch(settings, applySettings);
  const onSystemTheme = () => term.restyle();
  darkQuery.addEventListener("change", onSystemTheme);
  void loadSettings().then(() => {
    const path = settingsPath.get();
    if (path) void fsWatch(dirname(path)).catch(() => {});
  });
  const settingsListener = onFsChanged(({ paths }) => {
    const path = settingsPath.get();
    if (path && paths.includes(path)) void loadSettings();
  });

  const run = (action: KeyAction) => {
    switch (action.type) {
      case "newTab":
        return term.newTab();
      case "closeTab":
        // Cmd+W closes what has focus: a viewer doc, otherwise the terminal tab.
        return side.contains(document.activeElement) ? commands.closeActiveDoc() : term.closeTab();
      case "selectTab":
        return term.selectTab(action.index);
      case "clear":
        return term.clear();
      case "copy":
        return term.copy();
      case "paste":
        return term.paste();
      case "toggleSidebar":
        return sidebarVisible.set(!sidebarVisible.get());
      case "toggleViewer":
        return viewerVisible.set(!viewerVisible.get());
      case "newFile":
        return newFile();
      case "openFolder":
        return void openFolder();
      case "send":
        return term.send(action.data);
      case "find":
        return term.find();
      case "block":
        return term.block(action.direction);
      case "palette":
        return palette.open();
      case "search":
        return palette.open("search");
      case "split":
        return term.split();
      case "settings":
        return openSettings(openSettingsFile);
      case "sendSelection": {
        // Hands the agent a pointer to the code ("src/a.ts:3-7 "), then lets you type the ask.
        const ref = viewer.selectionRef();
        if (!ref) return toast("Select lines in a file or diff first.");
        if (hasControlChars(ref)) return toast("Not sent: the file name contains a control character.");
        commands.pasteToTerminal(`${ref} `);
        return term.focus();
      }
    }
  };

  // Capture phase, so app shortcuts are handled before xterm.js or CodeMirror sees the key.
  const onKeyDown = (e: KeyboardEvent) => {
    const action = keyAction(e, terminal.isMac, keymap);
    if (!action) return;
    // Shift+Enter's escape sequence, Cmd+F and Cmd+Up/Down are the terminal's only while it has
    // focus; elsewhere the editor keeps its own Shift+Enter, search and cursor moves.
    const terminalOnly = action.type === "send" || action.type === "find" || action.type === "block";
    if (terminalOnly && !term.host.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    run(action);
  };
  addEventListener("keydown", onKeyDown, true);

  // First start on macOS: one Full Disk Access grant instead of a prompt per protected folder.
  if (terminal.isMac) {
    let asked = false;
    try {
      asked = localStorage.getItem("fullDiskAccessOffered") === "1";
      localStorage.setItem("fullDiskAccessOffered", "1");
    } catch {}
    if (!asked) void offerFullDiskAccess().catch(() => {});
  }

  const menuListener = onMenu((id) => {
    if (id === "new_file") newFile();
    else if (id === "open_folder") void openFolder();
    else if (id === "settings") openSettings(openSettingsFile);
  });

  const unsubs = [
    watch(followMode, (on) => follow.setAttribute("aria-pressed", String(on))),
    // Always visible so it can be found; it only works inside a git repository.
    watch(repo, (r) => {
      follow.disabled = !r;
      follow.title = r ? "Show each file's diff as it changes" : "Follow works inside a git repository: cd into one first";
    }),
    // On a narrow window, browsing the tree opens the drawer so the preview is visible.
    selected.subscribe((sel) => {
      if (sel && isCompact()) viewerVisible.set(true);
    }),
    watch(sidebarView, (v) => {
      filesView.hidden = v !== "files";
      gitView.hidden = v !== "git";
    }),
    watch(sidebarVisible, (v) => {
      sidebar.hidden = leftHandle.hidden = !v;
    }),
    watch(viewerMode, (m) => {
      docsArea.hidden = m !== "docs";
    }),
    watch(viewerVisible, (v) => {
      side.hidden = rightHandle.hidden = !v;
    }),
  ];

  return () => {
    removeEventListener("keydown", onKeyDown, true);
    void menuListener.then((u) => u());
    unsubs.forEach((u) => u());
    disposeQuickLook();
    disposeWeb();
    disposeViewer();
    term.dispose();
    unsubSettings();
    darkQuery.removeEventListener("change", onSystemTheme);
    void settingsListener.then((u) => u());
    stopFollow();
    follow.remove();
    disposeBadge();
    disposeGit();
    disposeTree();
    disposeSwitch();
    workspace.remove();
    statusBar.remove();
  };
}
