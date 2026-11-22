import {
  errorCode,
  errorMessage,
  fsCreateDir,
  fsCreateFile,
  fsListDir,
  fsRename,
  fsReveal,
  fsStat,
  fsTrash,
  fsUnwatch,
  fsWatch,
  onFsChanged,
  type Entry,
  type Kind,
} from "../ipc.ts";
import { ancestors, basename, dirname, isInside, join, PATH_MIME } from "../paths.ts";
import { commands } from "../state/commands.ts";
import { openDoc, quickLook, renamePath, selected, treeRoot } from "../state/files.ts";
import { gitState, repo } from "../state/git.ts";
import { activeCwd, activeTabId, tabs } from "../state/tabs.ts";
import { showMenu, type MenuItem } from "../ui/menu.ts";
import { promptName } from "../ui/prompt.ts";
import { toast } from "../ui/toast.ts";

type Node = {
  path: string;
  name: string;
  kind: Kind;
  ignored: boolean;
  depth: number;
  expanded: boolean;
  children: Node[] | null;
};

const ROW = 22;
const OVERSCAN = 10;
const isMac = navigator.userAgent.includes("Mac");

/** The git root containing `dir`, or `dir` itself outside a repo. */
async function findRoot(dir: string): Promise<{ root: string; isRepo: boolean }> {
  for (const d of ancestors(dir)) {
    // `.git` is a folder in a normal repo and a file in a worktree; both count.
    if (await fsStat(join(d, ".git")).then(() => true, () => false)) return { root: d, isRepo: true };
  }
  return { root: dir, isRepo: false };
}

// Set by mount: re-lists a folder now instead of waiting for the watcher.
let refresh: (dir: string) => Promise<void> = async () => {};

const failed = (e: unknown, name: string) =>
  toast(errorCode(e) === "exists" ? `“${name}” already exists.` : errorMessage(e));

export async function newFileIn(dir: string): Promise<void> {
  const name = await promptName("New file name");
  if (!name) return;
  const path = join(dir, name);
  try {
    await fsCreateFile(path);
  } catch (e) {
    return failed(e, name);
  }
  await refresh(dir);
  selected.set({ path, kind: "file" });
  openDoc(path, "file", { focus: true });
}

async function newFolderIn(dir: string): Promise<void> {
  const name = await promptName("New folder name");
  if (!name) return;
  const path = join(dir, name);
  try {
    await fsCreateDir(path);
  } catch (e) {
    return failed(e, name);
  }
  await refresh(dir);
  selected.set({ path, kind: "dir" });
}

async function renameItem(path: string, kind: Kind): Promise<void> {
  const old = basename(path);
  const name = await promptName(`Rename “${old}”`, old);
  if (!name || name === old) return;
  const to = join(dirname(path), name);
  try {
    await fsRename(path, to);
  } catch (e) {
    return failed(e, name);
  }
  renamePath(path, to);
  await refresh(dirname(path));
  selected.set({ path: to, kind });
}

async function trashItem(path: string): Promise<void> {
  try {
    await fsTrash([path]);
  } catch (e) {
    return toast(errorMessage(e));
  }
  if (selected.get()?.path === path) selected.set(null);
  await refresh(dirname(path));
}

/** The file tree in the sidebar, rooted at the active tab's folder (its git root inside a repo). */
export function mount(parent: HTMLElement): () => void {
  const header = document.createElement("div");
  header.className = "filetree-header";
  const headerName = document.createElement("span");
  headerName.className = "filetree-name";
  header.append(headerName);
  const el = document.createElement("div");
  el.className = "filetree";
  el.tabIndex = 0;
  el.setAttribute("role", "tree");
  el.setAttribute("aria-label", "Files");
  const spacer = document.createElement("div");
  const win = document.createElement("div");
  win.className = "filetree-window";
  el.append(spacer, win);
  parent.append(header, el);

  let root: Node | null = null;
  let rows: Node[] = [];
  const byPath = new Map<string, Node>();
  const watched = new Set<string>();
  /** Path -> git status, for colouring rows; the working-tree status wins over the staged one. */
  let gitByPath = new Map<string, string>();

  const watch = (n: Node) => {
    // Ignored folders (node_modules, target) are never watched: they cause event storms.
    if (n.ignored || watched.has(n.path)) return;
    watched.add(n.path);
    void fsWatch(n.path).catch(() => watched.delete(n.path));
  };

  /** Forgets a node and its loaded descendants, dropping their watches. */
  const release = (n: Node) => {
    if (watched.delete(n.path)) void fsUnwatch(n.path).catch(() => {});
    byPath.delete(n.path);
    for (const c of n.children ?? []) release(c);
  };

  const render = () => {
    spacer.style.height = `${rows.length * ROW}px`;
    const first = Math.max(0, Math.floor(el.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / ROW) + OVERSCAN);
    win.style.transform = `translateY(${first * ROW}px)`;
    const sel = selected.get()?.path;
    win.replaceChildren(
      ...rows.slice(first, last).map((n) => {
        const row = document.createElement("div");
        const git = gitByPath.get(n.path);
        row.className =
          "tree-row" + (n.path === sel ? " selected" : "") + (n.ignored ? " ignored" : "") + (git ? ` git-${git}` : "");
        row.dataset.path = n.path;
        row.draggable = true;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(n.depth + 1));
        row.setAttribute("aria-selected", String(n.path === sel));
        if (n.kind === "dir") row.setAttribute("aria-expanded", String(n.expanded));
        row.style.paddingLeft = `${6 + n.depth * 14}px`;
        const chevron = document.createElement("span");
        chevron.className = "tree-chevron";
        chevron.textContent = n.kind === "dir" ? (n.expanded ? "▾" : "▸") : "";
        const icon = document.createElement("span");
        icon.className = `tree-icon ${n.kind}`;
        const name = document.createElement("span");
        name.className = "tree-name";
        name.textContent = n.name;
        row.append(chevron, icon, name);
        return row;
      }),
    );
  };

  const flatten = () => {
    rows = [];
    const walk = (n: Node) => {
      for (const c of n.children ?? []) {
        rows.push(c);
        if (c.expanded) walk(c);
      }
    };
    if (root) walk(root);
    render();
  };

  const toNodes = (parentNode: Node, entries: Entry[]): Node[] => {
    const old = new Map((parentNode.children ?? []).map((c) => [c.path, c]));
    const next = entries.map((e) => {
      const path = join(parentNode.path, e.name);
      const prev = old.get(path);
      const ignored = e.ignored || parentNode.ignored;
      if (prev && prev.kind === e.kind) {
        old.delete(path);
        prev.ignored = ignored;
        return prev; // keeps its expanded state and children
      }
      const n: Node = { path, name: e.name, kind: e.kind, ignored, depth: parentNode.depth + 1, expanded: false, children: null };
      byPath.set(path, n);
      return n;
    });
    for (const gone of old.values()) release(gone);
    return next;
  };

  const load = async (n: Node) => {
    const entries = await fsListDir(n.path);
    if (byPath.get(n.path) !== n) return; // removed or re-rooted meanwhile
    n.children = toNodes(n, entries);
    flatten();
  };

  const expand = async (n: Node) => {
    if (n.kind !== "dir") return;
    n.expanded = true;
    watch(n);
    flatten();
    await load(n).catch((e) => toast(errorMessage(e)));
  };

  const collapse = (n: Node) => {
    for (const c of n.children ?? []) release(c);
    n.children = null;
    n.expanded = false;
    if (watched.delete(n.path)) void fsUnwatch(n.path).catch(() => {});
    flatten();
  };

  const toggle = (n: Node) => void (n.expanded ? collapse(n) : expand(n));

  // A cd the tree itself asked for: the shell's new folder must not re-root the tree.
  let keepRootFor: string | null = null;

  /** Opening a folder (double-click, Enter) also moves the active shell there when it is idle. */
  const openFolder = (n: Node) => {
    toggle(n);
    keepRootFor = n.path;
    const why = commands.cdInTerminal(n.path);
    if (why) {
      keepRootFor = null;
      toast(why);
    }
  };

  refresh = async (dir) => {
    const n = byPath.get(dir);
    if (n?.expanded) await load(n).catch(() => {});
    else if (n) await expand(n);
  };

  const setRoot = (path: string) => {
    if (root) release(root);
    rows = [];
    el.scrollTop = 0;
    root = { path, name: basename(path) || path, kind: "dir", ignored: false, depth: -1, expanded: true, children: null };
    byPath.set(path, root);
    headerName.textContent = root.name;
    headerName.title = path;
    void expand(root);
  };

  const scrollToRow = (i: number) => {
    if (i < 0) return;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  };

  /** Expands the ancestors of `path` so it shows in the tree, then scrolls to it. */
  const reveal = async (path: string) => {
    if (!root || !isInside(root.path, path)) return;
    const chain = ancestors(dirname(path)).filter((a) => isInside(root!.path, a)).reverse();
    for (const a of chain) {
      const n = byPath.get(a);
      if (!n) return;
      if (!n.expanded || !n.children) await expand(n);
    }
    scrollToRow(rows.findIndex((r) => r.path === path));
    render();
  };

  const select = (n: Node | undefined) => {
    if (n) selected.set({ path: n.path, kind: n.kind });
  };

  const rowNode = (e: Event) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    return row ? byPath.get(row.dataset.path!) : undefined;
  };

  // Double-click is read from the click count, not a dblclick event: the first click re-renders
  // the rows, and WebKit drops dblclick when the two clicks land on different elements.
  win.onclick = (e) => {
    const n = rowNode(e);
    if (!n) return;
    const onChevron = (e.target as HTMLElement).classList.contains("tree-chevron");
    if (e.detail === 2 && !onChevron) {
      if (n.kind === "dir") openFolder(n);
      else openDoc(n.path, "file", { focus: true });
      return;
    }
    if (onChevron) toggle(n);
    select(n);
    el.focus();
  };
  win.ondragstart = (e) => {
    const n = rowNode(e);
    if (!n || !e.dataTransfer) return;
    e.dataTransfer.setData(PATH_MIME, n.path);
    e.dataTransfer.setData("text/plain", n.path);
    e.dataTransfer.effectAllowed = "copy";
  };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    const n = rowNode(e);
    select(n);
    const target = n ?? root;
    if (!target) return;
    const dir = target.kind === "dir" ? target.path : dirname(target.path);
    const items: MenuItem[] = [
      { label: "New File…", run: () => void newFileIn(dir) },
      { label: "New Folder…", run: () => void newFolderIn(dir) },
      "separator",
    ];
    if (n) {
      items.push(
        { label: "Rename…", run: () => void renameItem(n.path, n.kind) },
        { label: "Move to Trash", hint: isMac ? "⌘⌫" : "Delete", run: () => void trashItem(n.path) },
        "separator",
      );
    }
    items.push(
      { label: "Copy Path", run: () => void navigator.clipboard.writeText(target.path) },
      {
        label: isMac ? "Reveal in Finder" : "Show in File Manager",
        run: () => void fsReveal(target.path).catch((err) => toast(errorMessage(err))),
      },
      { label: "Open Terminal Here", run: () => commands.newTab(dir) },
    );
    showMenu(e.clientX, e.clientY, items);
  };

  el.onkeydown = (e) => {
    const path = selected.get()?.path;
    const i = rows.findIndex((r) => r.path === path);
    const n = rows[i];
    switch (e.key) {
      case "ArrowDown":
        select(rows[Math.min(rows.length - 1, i + 1)]);
        break;
      case "ArrowUp":
        select(rows[Math.max(0, i - 1)]);
        break;
      case "ArrowRight":
        if (n?.kind === "dir") {
          if (!n.expanded) void expand(n);
          else select(n.children?.[0]);
        }
        break;
      case "ArrowLeft":
        if (n?.kind === "dir" && n.expanded) collapse(n);
        else if (n) select(byPath.get(dirname(n.path)) === root ? undefined : byPath.get(dirname(n.path)));
        break;
      case "Enter":
        if (n?.kind === "dir") openFolder(n);
        else if (n) openDoc(n.path, "file", { focus: true });
        break;
      case " ":
        if (n?.kind === "file" || quickLook.get()) quickLook.set(!quickLook.get());
        break;
      case "Escape":
        quickLook.set(false);
        break;
      case "Backspace":
      case "Delete":
        // Finder's Move to Trash: Cmd+Backspace on macOS; Delete on Linux.
        if (!n || (isMac ? !e.metaKey : e.key !== "Delete")) return;
        void trashItem(n.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  let scrollQueued = false;
  el.onscroll = () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      render();
    });
  };
  const resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(el);

  // Follow the active tab's folder. Titles change often (agents animate them), so only a
  // new cwd triggers the git-root lookup.
  let lastCwd: string | null = null;
  let followToken = 0;
  const follow = async () => {
    const cwd = activeCwd();
    if (!cwd || cwd === lastCwd) return;
    lastCwd = cwd;
    const fromTree = cwd === keepRootFor;
    keepRootFor = null;
    const token = ++followToken;
    const found = await findRoot(cwd);
    if (token !== followToken) return;
    // The repo always follows the shell, so Changes appears as soon as it is inside one.
    repo.set(found.isRepo ? found.root : null);
    // A cd started from the tree keeps the tree where it is, as long as the folder is in view.
    const r = treeRoot.get();
    if (fromTree && r && isInside(r, cwd)) return;
    treeRoot.set(found.root);
  };

  const unsubs = [
    tabs.subscribe(() => void follow()),
    activeTabId.subscribe(() => void follow()),
    treeRoot.subscribe((r) => r && setRoot(r)),
    gitState.subscribe((st) => {
      gitByPath = new Map();
      for (const f of st?.files ?? []) if (!f.staged || !gitByPath.has(f.path)) gitByPath.set(f.path, f.status);
      render();
    }),
    selected.subscribe((sel) => {
      if (sel && !rows.some((r) => r.path === sel.path)) void reveal(sel.path);
      else if (sel) scrollToRow(rows.findIndex((r) => r.path === sel.path));
      render();
    }),
  ];
  const changeListener = onFsChanged(({ root: dir }) => {
    const n = byPath.get(dir);
    if (n?.expanded) void load(n).catch(() => {});
  });

  headerName.textContent = "No folder";

  return () => {
    unsubs.forEach((u) => u());
    resizeObserver.disconnect();
    void changeListener.then((u) => u());
    if (root) release(root);
    header.remove();
    el.remove();
  };
}
