import type { Kind } from "../ipc.ts";
import { isInside } from "../paths.ts";
import { signal } from "../signal.ts";
import { viewerVisible } from "./layout.ts";

/** Root of the file tree: the active tab's folder, or its git root inside a repo. */
export const treeRoot = signal<string | null>(null);

/** The tree's selection; the viewer previews it. */
export type Selection = { path: string; kind: Kind };
export const selected = signal<Selection | null>(null);

/** Quick Look overlay over the window, following the selection. */
export const quickLook = signal(false);

/**
 * A file, folder or git diff shown in the viewer. At most one doc is the replaceable preview
 * slot. `staged` only matters for diffs: the index against HEAD, or the working tree against the index.
 */
export type DocKind = "file" | "dir" | "diff";
export type Doc = { id: number; path: string; kind: DocKind; staged: boolean; preview: boolean; dirty: boolean };
export const docs = signal<Doc[]>([]);
export const activeDocId = signal<number | null>(null);

/** Requested cursor position for a doc, consumed by the viewer after it loads. */
export type Jump = { docId: number; line: number; col: number };
export const jump = signal<Jump | null>(null);
/** Set when a newly opened doc should take keyboard focus (New File, Enter in the tree). */
export const focusDoc = signal<number | null>(null);

let nextDocId = 0;

export type OpenOptions = { preview?: boolean; line?: number; col?: number; focus?: boolean; staged?: boolean };

export function openDoc(path: string, kind: DocKind, opts: OpenOptions = {}): void {
  const list = docs.get();
  const staged = kind === "diff" && !!opts.staged;
  let doc = list.find((d) => d.path === path && d.kind === kind && d.staged === staged);
  if (doc) {
    if (!opts.preview && doc.preview) {
      doc = { ...doc, preview: false };
      const promoted = doc;
      docs.set(list.map((d) => (d.id === promoted.id ? promoted : d)));
    }
  } else {
    doc = { id: ++nextDocId, path, kind, staged, preview: !!opts.preview, dirty: false };
    const slot = opts.preview ? list.findIndex((d) => d.preview) : -1;
    docs.set(slot >= 0 ? list.with(slot, doc) : [...list, doc]);
  }
  activeDocId.set(doc.id);
  if (!opts.preview) viewerVisible.set(true);
  if (opts.line) jump.set({ docId: doc.id, line: opts.line, col: opts.col ?? 1 });
  if (opts.focus) focusDoc.set(doc.id);
}

export const updateDoc = (id: number, change: Partial<Doc>) =>
  docs.set(docs.get().map((d) => (d.id === id ? { ...d, ...change } : d)));

/** Removes a doc; the caller has already asked about unsaved changes. */
export function removeDoc(id: number): void {
  const list = docs.get();
  const index = list.findIndex((d) => d.id === id);
  if (index < 0) return;
  const rest = list.filter((d) => d.id !== id);
  docs.set(rest);
  if (activeDocId.get() === id) activeDocId.set(rest[Math.min(index, rest.length - 1)]?.id ?? null);
}

/** Keeps open docs (and the selection) pointing at a file or folder after it is renamed. */
export function renamePath(from: string, to: string): void {
  const move = (p: string) => (isInside(from, p) ? to + p.slice(from.length) : p);
  docs.set(docs.get().map((d) => (isInside(from, d.path) ? { ...d, path: move(d.path) } : d)));
  const sel = selected.get();
  if (sel && isInside(from, sel.path)) selected.set({ ...sel, path: move(sel.path) });
}
