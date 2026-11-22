import * as filetree from "./filetree/index.ts";
import { onMenu, pickFolder } from "./ipc.ts";
import { keyAction, type KeyAction } from "./keys.ts";
import { commands } from "./state/commands.ts";
import { treeRoot } from "./state/files.ts";
import { sidebarVisible, viewerVisible } from "./state/layout.ts";
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

/** Layout: sidebar (file tree) | terminal | side panel (viewer). */
export function mountApp(root: HTMLElement): () => void {
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  const main = document.createElement("main");
  main.className = "terminal-column";
  const side = document.createElement("section");
  side.className = "viewer";
  side.setAttribute("aria-label", "Viewer");
  const leftHandle = resizer(sidebar, 1);
  const rightHandle = resizer(side, -1);
  root.append(sidebar, leftHandle, main, rightHandle, side);

  const disposeTree = filetree.mount(sidebar);
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
    }
  };

  // Capture phase, so app shortcuts are handled before xterm.js or CodeMirror sees the key.
  const onKeyDown = (e: KeyboardEvent) => {
    const action = keyAction(e, terminal.isMac);
    if (!action) return;
    // Shift+Enter's escape sequence is for the terminal; the editor keeps its own Shift+Enter.
    if (action.type === "send" && !term.host.contains(e.target as Node)) return;
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
    disposeTree();
    for (const node of [sidebar, leftHandle, main, rightHandle, side]) node.remove();
  };
}
