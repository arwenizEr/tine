import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { closeWindow, onPtyExit, openUrl, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../ipc.ts";
import { activeTabId, setTabTitle, tabs } from "../state/tabs.ts";
import { keyAction, type KeyAction } from "./keys.ts";
import { mountTabBar } from "./tabbar.ts";

type Session = {
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  ptyId: number | null;
};

const isMac = navigator.userAgent.includes("Mac");

function cssVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

function themeFromCss(): ITheme {
  const s = getComputedStyle(document.documentElement);
  return {
    background: cssVar(s, "--term-bg"),
    foreground: cssVar(s, "--term-fg"),
    cursor: cssVar(s, "--term-cursor"),
    selectionBackground: cssVar(s, "--term-selection"),
  };
}

/** The terminal panel: tab strip plus one xterm.js instance and one PTY per tab. */
export function mount(root: HTMLElement): () => void {
  const sessions = new Map<number, Session>();
  let nextId = 0;

  const host = document.createElement("div");
  host.className = "terminals";

  const active = () => sessions.get(activeTabId.get() ?? -1);

  const activate = (id: number) => {
    activeTabId.set(id);
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

    const session: Session = { id, term, fit, el, ptyId: null };
    sessions.set(id, session);
    tabs.set([...tabs.get(), { id, title: "shell" }]);
    activate(id);
    term.onTitleChange((title) => setTabTitle(id, title || "shell"));

    let ptyId: number;
    try {
      ptyId = await ptySpawn(term.cols, term.rows, (bytes) => term.write(bytes), cwd);
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

  const run = (action: KeyAction) => {
    const s = active();
    switch (action.type) {
      case "newTab":
        return void create();
      case "closeTab":
        return s && close(s.id);
      case "selectTab": {
        const tab = tabs.get()[action.index];
        return tab && activate(tab.id);
      }
      case "clear":
        return s?.term.clear();
      case "copy":
        if (s?.term.hasSelection()) void navigator.clipboard.writeText(s.term.getSelection());
        return;
      case "paste":
        if (s) void navigator.clipboard.readText().then((text) => s.term.paste(text));
        return;
      case "send":
        if (s?.ptyId != null) void ptyWrite(s.ptyId, action.data).catch(() => {});
        return;
    }
  };

  // Capture phase, so app shortcuts are handled before xterm.js sees the key.
  const onKeyDown = (e: KeyboardEvent) => {
    const action = keyAction(e, isMac);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    run(action);
  };
  window.addEventListener("keydown", onKeyDown, true);

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

  void create();

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    resizeObserver.disconnect();
    void exitListener.then((unlisten) => unlisten());
    for (const id of [...sessions.keys()]) close(id);
    disposeTabBar();
    host.remove();
  };
}
