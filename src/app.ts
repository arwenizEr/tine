import * as filetree from "./filetree/index.ts";
import { mountBadge } from "./git/badge.ts";
import { startFollow } from "./git/follow.ts";
import * as gitPanel from "./git/index.ts";
import { onMenu, pickFolder } from "./ipc.ts";
import { keyAction, type KeyAction } from "./keys.ts";
import { commands } from "./state/commands.ts";
import { selected, treeRoot } from "./state/files.ts";
import { followMode, isCompact, sidebarVisible, viewerVisible } from "./state/layout.ts";
import { gitState, repo, sidebarView } from "./state/git.ts";
import { activeCwd } from "./state/tabs.ts";
import * as terminal from "./terminal/index.ts";
import { toast } from "./ui/toast.ts";
import * as viewer from "./viewer/index.ts";
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

/** Sidebar switch between the file tree and the git panel; Changes only shows inside a repo. */
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
    changes.hidden = !repo.get();
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
  const disposeViewer = viewer.mount(side);
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
    }
  };

  // Capture phase, so app shortcuts are handled before xterm.js or CodeMirror sees the key.
  const onKeyDown = (e: KeyboardEvent) => {
    const action = keyAction(e, terminal.isMac);
    if (!action) return;
    // Shift+Enter's escape sequence and Cmd+F are the terminal's only while it has focus;
    // elsewhere the editor keeps its own Shift+Enter and search.
    if ((action.type === "send" || action.type === "find") && !term.host.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    run(action);
  };
  addEventListener("keydown", onKeyDown, true);

  const menuListener = onMenu((id) => {
    if (id === "new_file") newFile();
    else if (id === "open_folder") void openFolder();
  });

  const unsubs = [
    followMode.subscribe((on) => follow.setAttribute("aria-pressed", String(on))),
    // Always visible so it can be found; it only works inside a git repository.
    repo.subscribe((r) => {
      follow.disabled = !r;
      follow.title = r ? "Show each file's diff as it changes" : "Follow works inside a git repository: cd into one first";
    }),
    // On a narrow window, browsing the tree opens the drawer so the preview is visible.
    selected.subscribe((sel) => {
      if (sel && isCompact()) viewerVisible.set(true);
    }),
    sidebarView.subscribe((v) => {
      filesView.hidden = v !== "files";
      gitView.hidden = v !== "git";
    }),
    sidebarVisible.subscribe((v) => {
      sidebar.hidden = leftHandle.hidden = !v;
    }),
    viewerVisible.subscribe((v) => {
      side.hidden = rightHandle.hidden = !v;
    }),
  ];

  return () => {
    removeEventListener("keydown", onKeyDown, true);
    void menuListener.then((u) => u());
    unsubs.forEach((u) => u());
    disposeQuickLook();
    disposeViewer();
    term.dispose();
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
