import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { closeWindow, fsStat, notify, onFileDrop, onPtyExit, openUrl, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../ipc.ts";
import { toast } from "../components/toast.ts";
import { notification } from "./marks.ts";
import { findPathLinks, parseOsc7, PATH_MIME, resolve, shellQuote } from "../paths.ts";
import { commands } from "../state/commands.ts";
import { openDoc, selected } from "../state/files.ts";
import { settings } from "../state/settings.ts";
import { activeCwd, activeTabId, type Activity, setTabActivity, splitPair, setTabCwd, setTabTitle, tabs } from "../state/tabs.ts";
import { Blocks } from "./blocks.ts";
import { mountSearch } from "./search.ts";
import { mountTabBar } from "./tabbar.ts";

type Session = {
  id: number;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  blocks: Blocks;
  el: HTMLElement;
  ptyId: number | null;
};

/** Output this soon after a keystroke is its echo, not the program working on its own. */
const ECHO_MS = 250;
const UNSAFE_NAME = "Not typed into the terminal: the name contains a line break or other control character.";
/** Notification text that means "blocked on you", e.g. Claude Code's "needs your permission". */
const WAITING = /permission|approv|confirm|allow/i;
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
  /** Scrolls to the previous (-1) or next (1) command block. */
  block(direction: -1 | 1): void;
  /** Re-reads font and colours (settings or light/dark changed) for every tab. */
  restyle(): void;
  /** Gives the active tab keyboard focus. */
  focus(): void;
  /** Shows a new tab beside the active one, or goes back to one tab when split. */
  split(): void;
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

  const fitVisible = () => {
    for (const s of sessions.values()) if (!s.el.hidden) s.fit.fit();
  };

  /** Shows the active tab, or both tabs of the split pair. */
  const layout = () => {
    const pair = splitPair.get();
    host.classList.toggle("split", pair !== null);
    for (const s of sessions.values()) {
      const pane = pair ? pair.indexOf(s.id) : s.id === activeTabId.get() ? 0 : -1;
      s.el.hidden = pane < 0;
      s.el.classList.toggle("pane-right", pair !== null && pane === 1);
    }
    fitVisible();
  };

  const activate = (id: number) => {
    if (activeTabId.get() !== id) search.close();
    // A tab picked while split replaces the pane that has focus.
    const pair = splitPair.get();
    const current = activeTabId.get();
    if (pair && !pair.includes(id)) splitPair.set(pair[0] === current ? [id, pair[1]] : [pair[0], id]);
    activeTabId.set(id);
    if ((tabs.get().find((t) => t.id === id)?.activity ?? "idle") !== "busy") setTabActivity(id, "idle");
    layout();
    sessions.get(id)?.term.focus();
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
    // Closing either half of a split leaves the other half on its own.
    const pair = splitPair.get();
    const other = pair?.includes(id) ? pair.find((p) => p !== id) : undefined;
    if (other !== undefined) splitPair.set(null);
    if (rest.length === 0) {
      void closeWindow();
    } else if (activeTabId.get() === id) {
      activate(other ?? rest[Math.min(index, rest.length - 1)].id);
    } else if (other !== undefined) {
      layout();
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

  const create = async (cwd?: string, beside?: number) => {
    const id = ++nextId;
    const el = document.createElement("div");
    el.className = "terminal";
    host.append(el);
    // Clicking into a pane of a split gives that tab focus.
    el.addEventListener("focusin", () => {
      if (activeTabId.get() !== id && sessions.has(id)) activate(id);
    });

    const term = new Terminal({
      allowProposedApi: true, // needed by the unicode11 addon
      macOptionIsMeta: true,
      cursorBlink: true,
      scrollback: 10_000,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono-font"),
      fontSize: settings.get().font_size ?? 13,
      theme: themeFromCss(),
      linkHandler: { activate: (_e, uri) => void openUrl(uri) }, // OSC 8 links
    });
    // Signs this tab's shell marks (see Blocks): 128 random bits, letters and digits only.
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
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

    const session: Session = { id, term, fit, search: searchAddon, blocks: new Blocks(term, token), el, ptyId: null };
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
    // Bell and OSC 9 are how agents say "done" or "need you": mark the tab, and notify the
    // desktop when tine is in the background.
    const attention = (message: string, activity: Activity = "attention") => {
      if (looking(id)) return;
      setTabActivity(id, activity);
      if (!document.hasFocus()) {
        const { title, body } = notification(tabs.get().find((t) => t.id === id)?.title ?? "", message);
        void notify(title, body);
      }
    };
    term.onBell(() => attention("Finished, or waiting for you"));
    term.parser.registerOscHandler(9, (data) => {
      // OSC 9;4 is a progress report (ConEmu, Windows Terminal), not a notification.
      // Agents name a permission prompt in the text; that tab is blocked until you answer.
      if (!/^4;/.test(data)) attention(data || "Needs your attention", WAITING.test(data) ? "waiting" : "attention");
      return true;
    });
    term.onData((data) => {
      lastInput = performance.now();
      if (data.includes("\r")) commands.turnStarted();
    });
    if (beside !== undefined && sessions.has(beside)) splitPair.set([beside, id]);
    activate(id);
    term.onTitleChange((title) => setTabTitle(id, title || "shell"));
    term.parser.registerOscHandler(7, (data) => {
      const dir = parseOsc7(data);
      if (dir) setTabCwd(id, dir);
      return true;
    });
    term.registerLinkProvider(pathLinkProvider(session));

    let ptyId: number;
    const onBytes = (bytes: Uint8Array) => {
      term.write(bytes);
      onOutput();
    };
    try {
      // A restored folder may be gone by now: start in the home folder instead.
      ptyId = await ptySpawn(term.cols, term.rows, onBytes, token, cwd).catch((e) => {
        if (!cwd) throw e;
        return ptySpawn(term.cols, term.rows, onBytes, token);
      });
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

  const resizeObserver = new ResizeObserver(fitVisible);
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
      const quoted = paths.map(shellQuote);
      if (quoted.includes(null)) return toast(UNSAFE_NAME);
      s.term.paste(quoted.join(" ") + " ");
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
      const quoted = shellQuote(path);
      if (quoted === null) return toast(UNSAFE_NAME);
      s.term.paste(quoted + " ");
      s.term.focus();
    },
    true,
  );

  /** Types a command line into an idle shell; Ctrl+U first clears anything half-typed. */
  const runCommand = (s: Session, line: string): string | null => {
    if (s.ptyId === null) return "The shell is not running.";
    if (!s.blocks.integrated) return "This shell has no tine integration (zsh and bash have it).";
    if (!s.blocks.atPrompt) return "The shell is busy; wait for its prompt.";
    void ptyWrite(s.ptyId, `\x15${line}\r`).catch(() => {});
    s.term.focus();
    return null;
  };

  commands.cdInTerminal = (dir) => {
    const s = active();
    const quoted = shellQuote(dir);
    if (quoted === null) return UNSAFE_NAME;
    return s ? runCommand(s, ` cd -- ${quoted}`) : "No terminal";
  };

  // Coming back to the window counts as looking at the active tab.
  const onWindowFocus = () => {
    const id = activeTabId.get();
    if (id !== null && (tabs.get().find((t) => t.id === id)?.activity ?? "idle") !== "busy") setTabActivity(id, "idle");
  };
  addEventListener("focus", onWindowFocus);

  commands.newTab = (cwd) => void create(cwd);
  commands.pasteToTerminal = (text) => active()?.term.paste(text);

  // Restore tabs: the same folders as last time (the programs that ran there are not restarted).
  const SAVED = "tabs";
  type Saved = { cwds: (string | null)[]; active: number };
  const save = () => {
    const list = tabs.get();
    const saved: Saved = { cwds: list.map((t) => t.cwd), active: list.findIndex((t) => t.id === activeTabId.get()) };
    try {
      localStorage.setItem(SAVED, JSON.stringify(saved));
    } catch {
      // Storage unavailable: tabs simply are not restored next time.
    }
  };
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(SAVED) ?? "null");
  } catch {
    saved = null;
  }
  const restore = saved?.cwds.length ? saved : { cwds: [null], active: 0 };
  const unsubSave: (() => void)[] = [];
  void Promise.all(restore.cwds.map((cwd) => create(cwd ?? undefined))).then(() => {
    const tab = tabs.get()[restore.active];
    if (tab) activate(tab.id);
    unsubSave.push(tabs.subscribe(save), activeTabId.subscribe(save));
  });

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
    focus: () => active()?.term.focus(),
    split: () => {
      const id = activeTabId.get();
      if (splitPair.get()) {
        splitPair.set(null);
        layout();
        active()?.term.focus();
      } else if (id !== null) {
        void create(activeCwd() ?? undefined, id);
      }
    },
    block: (direction) => active()?.blocks.jump(direction),
    restyle: () => {
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--mono-font");
      const fontSize = settings.get().font_size ?? 13;
      const theme = themeFromCss();
      for (const s of sessions.values()) {
        s.term.options.fontFamily = fontFamily;
        s.term.options.fontSize = fontSize;
        s.term.options.theme = theme;
      }
      fitVisible();
    },
    send: (data) => {
      const s = active();
      if (s?.ptyId != null) void ptyWrite(s.ptyId, data).catch(() => {});
    },
    dispose: () => {
      unsubSave.forEach((u) => u());
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
