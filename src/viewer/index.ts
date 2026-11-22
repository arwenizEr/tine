import { Transaction, type EditorState, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assetUrl, confirmDialog, errorCode, errorMessage, fsStat, fsUnwatch, fsWatch, fsWriteFile, onFsChanged, openUrl, type Stat } from "../ipc.ts";
import { basename, dirname } from "../paths.ts";
import { commands } from "../state/commands.ts";
import { activeDocId, docs, focusDoc, jump, openDoc, removeDoc, selected, updateDoc, type Doc } from "../state/files.ts";
import { toast } from "../ui/toast.ts";
import { infoCard, loadContent } from "./content.ts";
import { createState } from "./editor.ts";
import { renderFolder } from "./folder.ts";
import { renderMarkdown } from "./markdown.ts";

/** Why a text doc shows the bar above the editor. */
type Bar = null | "changed" | "conflict" | "deleted";

type TextDoc = {
  kind: "text";
  state: EditorState;
  /** Contents as last read from or written to disk; dirty means the editor differs. */
  saved: Text;
  /** Disk mtime the contents belong to; `undefined` once the file is gone. */
  mtime: number | undefined;
  editable: boolean;
  truncated: boolean;
  markdown: boolean;
  mode: "rendered" | "source";
  bar: Bar;
};

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "dir"; version: number }
  | { kind: "image"; stat: Stat }
  | { kind: "info"; stat: Stat; reason: string }
  | TextDoc;

const el = (tag: string, className: string) => Object.assign(document.createElement(tag), { className });

/** The viewer panel: open files and folders as tabs, plus one preview slot that follows the tree. */
export function mount(parent: HTMLElement): () => void {
  const tabsEl = el("nav", "doc-tabs");
  const toolbar = el("div", "doc-toolbar");
  const bar = el("div", "doc-bar");
  bar.setAttribute("role", "status");
  const body = el("div", "doc-body");
  const editorHost = el("div", "doc-editor");
  const markdownHost = el("article", "doc-markdown");
  const folderHost = el("div", "doc-folder");
  const imageHost = el("div", "doc-image");
  const infoHost = el("div", "doc-info");
  const hosts = [editorHost, markdownHost, folderHost, imageHost, infoHost];
  body.append(...hosts);
  parent.append(tabsEl, toolbar, bar, body);

  const loaded = new Map<number, Loaded>();
  const watching = new Map<number, { dir: string; ready: Promise<void> }>();
  let shownId: number | null = null; // doc whose state is in the editor view
  let folderShown: { id: number; version: number; cancel: () => void } | null = null;
  let markdownShown: { id: number; doc: Text } | null = null;

  const docOf = (id: number) => docs.get().find((d) => d.id === id);

  const view = new EditorView({
    parent: editorHost,
    dispatchTransactions: (trs) => {
      view.update(trs);
      const l = shownId !== null ? loaded.get(shownId) : undefined;
      if (l?.kind !== "text") return;
      l.state = view.state;
      // Reloads from disk are marked remote: they neither dirty nor promote the doc.
      if (trs.some((t) => t.docChanged && !t.annotation(Transaction.remote))) edited(shownId!, l);
    },
  });

  /** Typing in the preview slot turns it into a normal tab, as the plan's preview rules say. */
  const edited = (id: number, l: TextDoc) => {
    const doc = docOf(id);
    if (!doc) return;
    const dirty = !l.state.doc.eq(l.saved);
    if (doc.preview || doc.dirty !== dirty) updateDoc(id, { preview: false, dirty });
  };

  const watchDoc = (doc: Doc) => {
    const dir = doc.kind === "dir" ? doc.path : dirname(doc.path);
    const current = watching.get(doc.id);
    if (current?.dir === dir) return current.ready;
    if (current) void fsUnwatch(current.dir).catch(() => {});
    // Watching also opens the folder to the asset protocol, which image previews need.
    const ready = fsWatch(dir).catch(() => {});
    watching.set(doc.id, { dir, ready });
    return ready;
  };

  const load = async (doc: Doc) => {
    loaded.set(doc.id, { kind: "loading" });
    const ready = watchDoc(doc);
    let next: Loaded;
    try {
      const content = await loadContent(doc.path);
      switch (content.type) {
        case "dir":
          next = { kind: "dir", version: 0 };
          break;
        case "image":
          await ready;
          next = { kind: "image", stat: content.stat };
          break;
        case "info":
          next = { kind: "info", stat: content.stat, reason: content.reason };
          break;
        case "text": {
          const editable = !content.truncated;
          const state = await createState(doc.path, content.text, { editable, onSave: () => void save(doc.id) });
          const rendered = content.markdown && content.text.trim() !== "" && doc.preview;
          next = {
            kind: "text",
            state,
            saved: state.doc,
            mtime: content.mtime,
            editable,
            truncated: content.truncated,
            markdown: content.markdown,
            mode: rendered ? "rendered" : "source",
            bar: null,
          };
        }
      }
    } catch (e) {
      next = { kind: "error", message: errorMessage(e) };
    }
    // Dropped if the doc was closed or replaced while loading (stale preview).
    if (loaded.get(doc.id)?.kind === "loading") {
      loaded.set(doc.id, next);
      render();
    }
  };

  const save = async (id: number) => {
    const l = loaded.get(id);
    const doc = docOf(id);
    if (l?.kind !== "text" || !doc || !l.editable) return;
    const text = l.state.doc;
    try {
      l.mtime = await fsWriteFile(doc.path, text.toString(), l.mtime);
      l.saved = text;
      l.bar = null;
      updateDoc(id, { dirty: !l.state.doc.eq(text) });
    } catch (e) {
      if (errorCode(e) === "conflict") l.bar = "conflict";
      else toast(`Could not save ${basename(doc.path)}: ${errorMessage(e)}`);
    }
    render();
  };

  /** Replaces the editor contents with the file on disk. */
  const reload = async (id: number) => {
    const doc = docOf(id);
    const l = loaded.get(id);
    if (!doc || l?.kind !== "text") return;
    const content = await loadContent(doc.path).catch(() => null);
    if (content?.type !== "text" || loaded.get(id) !== l) return;
    // shortcut: replaces the whole document, so the cursor jumps; a minimal diff would keep it.
    const change = {
      changes: { from: 0, to: l.state.doc.length, insert: content.text },
      annotations: Transaction.remote.of(true),
    };
    if (shownId === id && view.state === l.state) view.dispatch(change);
    else l.state = l.state.update(change).state;
    l.saved = l.state.doc;
    l.mtime = content.mtime;
    l.bar = null;
    updateDoc(id, { dirty: false });
    render();
  };

  /** Called when a doc's file changed on disk (an agent, another program, or our own save). */
  const checkDisk = async (doc: Doc) => {
    const l = loaded.get(doc.id);
    if (!l || l.kind === "loading") return;
    if (l.kind !== "text") return void load(doc);
    const stat = await fsStat(doc.path).catch((e) => (errorCode(e) === "not_found" ? null : undefined));
    if (stat === undefined || loaded.get(doc.id) !== l) return;
    if (stat === null) {
      if (!docOf(doc.id)?.dirty) return removeDoc(doc.id);
      l.bar = "deleted";
    } else if (stat.mtime === l.mtime) {
      return; // our own save
    } else if (!docOf(doc.id)?.dirty) {
      return void reload(doc.id);
    } else {
      l.bar = "changed";
    }
    render();
  };

  const keepMine = async (id: number) => {
    const l = loaded.get(id);
    const doc = docOf(id);
    if (l?.kind !== "text" || !doc) return;
    // The next save overwrites what is on disk now (or recreates a deleted file).
    l.mtime = (await fsStat(doc.path).catch(() => null))?.mtime;
    l.bar = null;
    render();
  };

  const closeDoc = async (id: number) => {
    const doc = docOf(id);
    if (!doc) return;
    if (doc.dirty && !(await confirmDialog("Unsaved changes", `Discard your changes to ${basename(doc.path)}?`))) return;
    removeDoc(id);
  };
  commands.closeActiveDoc = () => {
    const id = activeDocId.get();
    if (id !== null) void closeDoc(id);
  };

  const renderTabs = () => {
    const active = activeDocId.get();
    tabsEl.replaceChildren(
      ...docs.get().map((doc) => {
        const tab = el("div", "doc-tab" + (doc.id === active ? " active" : "") + (doc.preview ? " preview" : ""));
        tab.title = doc.path;
        const name = el("span", "doc-tab-name");
        name.textContent = basename(doc.path) || doc.path;
        tab.append(name);
        if (doc.dirty) {
          const dot = el("span", "doc-dirty");
          dot.textContent = "●";
          dot.setAttribute("aria-label", "unsaved changes");
          tab.append(dot);
        }
        const close = el("button", "doc-close") as HTMLButtonElement;
        close.textContent = "×";
        close.setAttribute("aria-label", `Close ${basename(doc.path)}`);
        close.onclick = (e) => {
          e.stopPropagation();
          void closeDoc(doc.id);
        };
        tab.onclick = () => activeDocId.set(doc.id);
        tab.ondblclick = () => openDoc(doc.path, doc.kind); // pins a preview
        tab.append(close);
        return tab;
      }),
    );
  };

  const button = (label: string, run: () => void) => {
    const b = el("button", "bar-button") as HTMLButtonElement;
    b.textContent = label;
    b.onclick = run;
    return b;
  };

  const renderBar = (id: number, l: TextDoc) => {
    const messages: Record<Exclude<Bar, null>, string> = {
      changed: "This file changed on disk while you were editing it.",
      conflict: "Not saved: this file changed on disk after you opened it.",
      deleted: "This file was deleted on disk.",
    };
    if (l.bar) {
      bar.hidden = false;
      bar.className = "doc-bar warning";
      bar.replaceChildren(
        el("span", "bar-text"),
        ...(l.bar === "deleted" ? [] : [button("Reload from Disk", () => void reload(id))]),
        button("Keep My Edits", () => void keepMine(id)),
      );
      bar.firstChild!.textContent = messages[l.bar];
    } else if (l.truncated) {
      bar.hidden = false;
      bar.className = "doc-bar";
      bar.textContent = "Showing the first 2 MB. Large files are read-only here.";
    }
  };

  const render = () => {
    renderTabs();
    for (const h of hosts) h.hidden = true;
    bar.hidden = true;
    toolbar.hidden = true;
    const doc = docOf(activeDocId.get() ?? -1);
    if (!doc) {
      infoHost.hidden = false;
      infoHost.replaceChildren(el("div", "doc-empty"));
      infoHost.firstChild!.textContent = "Select a file in the tree, or Cmd+click a path in the terminal.";
      return;
    }
    const l = loaded.get(doc.id) ?? { kind: "loading" };
    if (folderShown && (l.kind !== "dir" || folderShown.id !== doc.id)) {
      folderShown.cancel();
      folderShown = null;
    }
    switch (l.kind) {
      case "loading":
        infoHost.hidden = false;
        infoHost.replaceChildren();
        return;
      case "error":
        infoHost.hidden = false;
        infoHost.replaceChildren(infoCard(basename(doc.path), null, l.message));
        return;
      case "info":
        infoHost.hidden = false;
        infoHost.replaceChildren(infoCard(basename(doc.path), l.stat, l.reason));
        return;
      case "image": {
        imageHost.hidden = false;
        const img = document.createElement("img");
        img.alt = basename(doc.path);
        img.src = `${assetUrl(doc.path)}?v=${l.stat.mtime}`;
        imageHost.replaceChildren(img);
        return;
      }
      case "dir":
        folderHost.hidden = false;
        if (folderShown?.id !== doc.id || folderShown.version !== l.version) {
          folderShown?.cancel();
          const cancel = renderFolder(folderHost, doc.path, (path, kind) => selected.set({ path, kind }));
          folderShown = { id: doc.id, version: l.version, cancel };
        }
        return;
      case "text":
        renderBar(doc.id, l);
        if (l.markdown) {
          toolbar.hidden = false;
          const toggle = (mode: TextDoc["mode"]) => () => {
            l.mode = mode;
            render();
            if (mode === "source") view.focus();
          };
          const rendered = button("Rendered", toggle("rendered"));
          const source = button("Source", toggle("source"));
          rendered.setAttribute("aria-pressed", String(l.mode === "rendered"));
          source.setAttribute("aria-pressed", String(l.mode === "source"));
          toolbar.replaceChildren(rendered, source);
        }
        if (l.markdown && l.mode === "rendered") {
          markdownHost.hidden = false;
          if (markdownShown?.id !== doc.id || markdownShown.doc !== l.state.doc) {
            markdownHost.innerHTML = renderMarkdown(l.state.doc.toString());
            markdownShown = { id: doc.id, doc: l.state.doc };
          }
          return;
        }
        editorHost.hidden = false;
        if (shownId !== doc.id || view.state !== l.state) {
          shownId = doc.id;
          view.setState(l.state);
        }
        applyJumpAndFocus(doc.id, l);
        return;
    }
  };

  const applyJumpAndFocus = (id: number, l: TextDoc) => {
    const j = jump.get();
    if (j?.docId === id) {
      jump.set(null);
      const line = l.state.doc.line(Math.min(Math.max(1, j.line), l.state.doc.lines));
      const pos = Math.min(line.from + Math.max(0, j.col - 1), line.to);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    }
    if (focusDoc.get() === id) {
      focusDoc.set(null);
      view.focus();
    }
  };

  // Rendered Markdown links open in the browser; nothing navigates the app's own page.
  markdownHost.onclick = (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && href !== "#") void openUrl(href);
  };

  const unsubs = [
    docs.subscribe((list) => {
      const ids = new Set(list.map((d) => d.id));
      for (const id of [...loaded.keys()]) {
        if (ids.has(id)) continue;
        loaded.delete(id);
        const w = watching.get(id);
        if (w) void fsUnwatch(w.dir).catch(() => {});
        watching.delete(id);
        if (shownId === id) shownId = null;
      }
      for (const d of list) {
        if (!loaded.has(d.id)) void load(d);
        else void watchDoc(d); // follows renames
      }
      render();
    }),
    activeDocId.subscribe(render),
    jump.subscribe((j) => {
      if (j) {
        const l = loaded.get(j.docId);
        if (l?.kind === "text") l.mode = "source";
        render();
      }
    }),
    focusDoc.subscribe((id) => {
      const l = id === null ? undefined : loaded.get(id);
      if (l?.kind === "text") {
        l.mode = "source";
        render();
      }
    }),
  ];

  // The preview slot follows the tree selection, debounced so holding an arrow key stays smooth.
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  unsubs.push(
    selected.subscribe((sel) => {
      clearTimeout(previewTimer);
      if (!sel || sel.kind === "other") return;
      previewTimer = setTimeout(() => openDoc(sel.path, sel.kind === "dir" ? "dir" : "file", { preview: true }), 50);
    }),
  );

  const changeListener = onFsChanged(({ root, paths }) => {
    for (const doc of docs.get()) {
      if (doc.kind === "dir") {
        const l = loaded.get(doc.id);
        if (doc.path === root && l?.kind === "dir") {
          l.version++;
          if (activeDocId.get() === doc.id) render();
        }
      } else if (paths.includes(doc.path)) {
        void checkDisk(doc);
      }
    }
  });

  render();

  return () => {
    unsubs.forEach((u) => u());
    clearTimeout(previewTimer);
    void changeListener.then((u) => u());
    folderShown?.cancel();
    for (const w of watching.values()) void fsUnwatch(w.dir).catch(() => {});
    view.destroy();
    for (const node of [tabsEl, toolbar, bar, body]) node.remove();
  };
}
