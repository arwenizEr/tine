import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { closeWindow, fsStat, onFileDrop, onPtyExit, openUrl, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../ipc.ts";
import { findPathLinks, parseOsc7, PATH_MIME, resolve, shellQuote } from "../paths.ts";
import { commands } from "../state/commands.ts";
import { openDoc, selected } from "../state/files.ts";
import { activeTabId, setTabActivity, setTabCwd, setTabTitle, tabs } from "../state/tabs.ts";
import { mountSearch } from "./search.ts";
import { mountTabBar } from "./tabbar.ts";

type Session = {
  id: number;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
  ptyId: number | null;
};

/** Output this soon after a keystroke is its echo, not the program working on its own. */
const ECHO_MS = 250;
/** A tab is quiet after this long without output. */
const QUIET_MS = 1500;
/** Only a tab that was busy at least this long earns the attention dot when it goes quiet. */
const LONG_RUN_MS = 2000;

export const isMac = navigator.userAgent.includes("Mac");

function themeFromCss(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--term-cursor"),
    selectionBackground: v("--term-selection"),
  };
}

/** Terminal panel actions, called by app-level shortcuts. */
export type TerminalActions = {
  newTab(cwd?: string): void;
  closeTab(): void;
  selectTab(index: number): void;
  clear(): void;
  copy(): void;
  paste(): void;
  /** Writes raw bytes (such as Shift+Enter's sequence) to the active shell. */
  send(data: string): void;
  /** Opens the find bar for the active tab's scrollback. */
  find(): void;
  /** The element holding the terminals, to tell whether a key or drop belongs to them. */
  host: HTMLElement;
  dispose(): void;
};

/** The terminal panel: tab strip plus one xterm.js instance and one PTY per tab. */
export function mount(root: HTMLElement): TerminalActions {
  const sessions = new Map<number, Session>();
  let nextId = 0;

  const host = document.createElement("div");
  host.className = "terminals";

  const active = () => sessions.get(activeTabId.get() ?? -1);

  const search = mountSearch(root, () => {
    const s = active();
    return s && { search: s.search, focus: () => s.term.focus() };
  });

  /** Looking at a tab means it is active and the window has focus. */
  const looking = (id: number) => activeTabId.get() === id && document.hasFocus();

  const activate = (id: number) => {
    if (activeTabId.get() !== id) search.close();
    activeTabId.set(id);
    if (tabs.get().find((t) => t.id === id)?.activity === "attention") setTabActivity(id, "idle");
    for (const s of sessions.values()) s.el.hidden = s.id !== id;
    const s = sessions.get(id);
    if (!s) return;
    s.fit.fit();
    s.term.focus();
  };

  const close = (id: number) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    // Already gone when the shell exited by itself.
    if (s.ptyId !== null) ptyKill(s.ptyId).catch(() => {});
    s.term.dispose();
    s.el.remove();
    const list = tabs.get();
    const index = list.findIndex((t) => t.id === id);
    const rest = list.filter((t) => t.id !== id);
    tabs.set(rest);
    if (rest.length === 0) {
      void closeWindow();
    } else if (activeTabId.get() === id) {
      activate(rest[Math.min(index, rest.length - 1)].id);
    }
  };

  /** Cmd+click (Ctrl+click on Linux) on a path in the output opens it in the viewer. */
  const pathLinkProvider = (session: Session) => ({
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const line = session.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const cwd = tabs.get().find((t) => t.id === session.id)?.cwd;
      // shortcut: ranges assume one cell per character, so links after wide (CJK, emoji) text are offset.
      const candidates = cwd ? findPathLinks(line) : [];
      if (!cwd || candidates.length === 0) return callback(undefined);
      void Promise.all(
        candidates.map(async (c): Promise<ILink | null> => {
          const path = resolve(cwd, c.path);
          const stat = await fsStat(path).catch(() => null);
          if (!stat || stat.kind === "other") return null;
          return {
            range: { start: { x: c.start + 1, y }, end: { x: c.end, y } },
            text: line.slice(c.start, c.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => {
              if (!(isMac ? e.metaKey : e.ctrlKey)) return;
              if (stat.kind === "dir") selected.set({ path, kind: "dir" });
              else openDoc(path, "file", { line: c.line, col: c.col, focus: true });
            },
          };
        }),
      ).then((links) => callback(links.filter((l) => l !== null)));
    },
  });

  const create = async (cwd?: string) => {
    const id = ++nextId;
    const el = document.createElement("div");
    el.className = "terminal";
    host.append(el);

    const term = new Terminal({
      allowProposedApi: true, // needed by the unicode11 addon
      macOptionIsMeta: true,
      cursorBlink: true,
      scrollback: 10_000,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono-font"),
      fontSize: 13,
      theme: themeFromCss(),
      linkHandler: { activate: (_e, uri) => void openUrl(uri) }, // OSC 8 links
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (activeTabId.get() === id) search.showCount(resultIndex, resultCount);
    });
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL (e.g. some WebKitGTK setups): xterm keeps its DOM renderer.
    }

    const session: Session = { id, term, fit, search: searchAddon, el, ptyId: null };
    sessions.set(id, session);
    tabs.set([...tabs.get(), { id, title: "shell", cwd: cwd ?? null, activity: "idle" }]);

    // Activity marks: busy while the program prints on its own, attention when a long run ends unseen.
    let lastInput = 0;
    let busySince = 0;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const onOutput = () => {
      const now = performance.now();
      if (now - lastInput < ECHO_MS) return;
      if (tabs.get().find((t) => t.id === id)?.activity !== "busy") {
        busySince = now;
        setTabActivity(id, "busy");
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        const ranLong = performance.now() - QUIET_MS - busySince >= LONG_RUN_MS;
        setTabActivity(id, ranLong && !looking(id) ? "attention" : "idle");
      }, QUIET_MS);
    };
    term.onBell(() => {
      if (!looking(id)) setTabActivity(id, "attention");
    });
    term.onData(() => {
      lastInput = performance.now();
    });
    activate(id);
    term.onTitleChange((title) => setTabTitle(id, title || "shell"));
    term.parser.registerOscHandler(7, (data) => {
      const dir = parseOsc7(data);
      if (dir) setTabCwd(id, dir);
      return true;
    });
    term.registerLinkProvider(pathLinkProvider(session));

    let ptyId: number;
    try {
      ptyId = await ptySpawn(
        term.cols,
        term.rows,
        (bytes) => {
          term.write(bytes);
          onOutput();
        },
        cwd,
      );
    } catch (e) {
      term.write(`\r\nCould not start the shell: ${(e as { message?: string }).message ?? e}\r\n`);
      return;
    }
    if (!sessions.has(id)) {
      void ptyKill(ptyId).catch(() => {}); // tab closed while the shell was starting
      return;
    }
    session.ptyId = ptyId;
    // shortcut: onBinary (legacy X10 mouse beyond column 95) is not forwarded; add if an app needs it.
    term.onData((data) => void ptyWrite(ptyId, data).catch(() => {}));
    term.onResize(({ cols, rows }) => void ptyResize(ptyId, cols, rows).catch(() => {}));
  };

  const disposeTabBar = mountTabBar(root, {
    select: activate,
    close,
    create: () => void create(),
  });
  root.append(host);

  const resizeObserver = new ResizeObserver(() => active()?.fit.fit());
  resizeObserver.observe(host);

  const exitListener = onPtyExit(({ pty_id }) => {
    for (const s of sessions.values()) {
      if (s.ptyId === pty_id) {
        s.ptyId = null;
        close(s.id);
      }
    }
  });

  // A file dropped on the terminal types its quoted path, as in iTerm2; agents pick up images this way.
  const dropListener = onFileDrop((paths, x, y) => {
    const s = active();
    if (s && host.contains(document.elementFromPoint(x, y))) {
      s.term.paste(paths.map(shellQuote).join(" ") + " ");
      s.term.focus();
    }
  });

  // The same for items dragged from tine's own tree or folder list (HTML drag and drop).
  host.addEventListener(
    "dragover",
    (e) => {
      if (!e.dataTransfer?.types.includes(PATH_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  host.addEventListener(
    "drop",
    (e) => {
      const path = e.dataTransfer?.getData(PATH_MIME);
      const s = active();
      if (!path || !s) return;
      e.preventDefault();
      e.stopPropagation();
      s.term.paste(shellQuote(path) + " ");
      s.term.focus();
    },
    true,
  );

  // Coming back to the window counts as looking at the active tab.
  const onWindowFocus = () => {
    const id = activeTabId.get();
    if (id !== null && tabs.get().find((t) => t.id === id)?.activity === "attention") setTabActivity(id, "idle");
  };
  addEventListener("focus", onWindowFocus);

  commands.newTab = (cwd) => void create(cwd);
  commands.pasteToTerminal = (text) => active()?.term.paste(text);

  void create();

  return {
    host,
    newTab: (cwd) => void create(cwd),
    closeTab: () => {
      const s = active();
      if (s) close(s.id);
    },
    selectTab: (index) => {
      const tab = tabs.get()[index];
      if (tab) activate(tab.id);
    },
    clear: () => active()?.term.clear(),
    copy: () => {
      const s = active();
      if (s?.term.hasSelection()) void navigator.clipboard.writeText(s.term.getSelection());
    },
    paste: () => {
      const s = active();
      if (s) void navigator.clipboard.readText().then((text) => s.term.paste(text));
    },
    find: () => search.open(),
    send: (data) => {
      const s = active();
      if (s?.ptyId != null) void ptyWrite(s.ptyId, data).catch(() => {});
    },
    dispose: () => {
      removeEventListener("focus", onWindowFocus);
      resizeObserver.disconnect();
      void exitListener.then((unlisten) => unlisten());
      void dropListener.then((unlisten) => unlisten());
      for (const id of [...sessions.keys()]) close(id);
      disposeTabBar();
      host.remove();
    },
  };
}
