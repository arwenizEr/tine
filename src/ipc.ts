// The only file that talks to Tauri. Uses the injected `window.__TAURI__` global
// (app.withGlobalTauri) so the frontend needs no @tauri-apps/* npm packages.

type TauriChannel<T> = { onmessage: (message: T) => void };
type Unlisten = () => void;
type DragDropEvent = { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } };
type TauriGlobal = {
  core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    Channel: new <T>() => TauriChannel<T>;
    convertFileSrc(path: string): string;
  };
  event: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<Unlisten>;
  };
  window: { getCurrentWindow(): { close(): Promise<void> } };
  webview: { getCurrentWebview(): { onDragDropEvent(handler: (e: DragDropEvent) => void): Promise<Unlisten> } };
  dialog: {
    open(options: { directory: boolean }): Promise<string | string[] | null>;
    ask(message: string, options: { title: string; kind: "warning" }): Promise<boolean>;
  };
};

const tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
const { invoke } = tauri.core;

/** Shape of every command error. */
export type AppError = { code: string; message: string };

export const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as AppError).message) : String(e);

export const errorCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as AppError).code) : undefined;

// --- PTY ---

export function ptySpawn(
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  cwd?: string,
): Promise<number> {
  const channel = new tauri.core.Channel<ArrayBuffer>();
  channel.onmessage = (bytes) => onData(new Uint8Array(bytes));
  return invoke("pty_spawn", { cwd, cols, rows, on_data: channel });
}

export const ptyWrite = (ptyId: number, data: string) => invoke<void>("pty_write", { pty_id: ptyId, data });

export const ptyResize = (ptyId: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { pty_id: ptyId, cols, rows });

export const ptyKill = (ptyId: number) => invoke<void>("pty_kill", { pty_id: ptyId });

export type PtyExit = { pty_id: number; code: number | null };

export const onPtyExit = (handler: (e: PtyExit) => void) =>
  tauri.event.listen<PtyExit>("pty-exit", (e) => handler(e.payload));

// --- Files ---

export type Kind = "file" | "dir" | "other";
export type Entry = { name: string; kind: Kind; ignored: boolean };
export type FileText = { text: string; truncated: boolean; binary: boolean; mtime: number };
export type Stat = { kind: Kind; size: number; mtime: number; item_count?: number };

export const fsListDir = (path: string) => invoke<Entry[]>("fs_list_dir", { path });
export const fsReadFile = (path: string) => invoke<FileText>("fs_read_file", { path });
export const fsStat = (path: string) => invoke<Stat>("fs_stat", { path });
export const fsWriteFile = (path: string, text: string, expectedMtime?: number) =>
  invoke<number>("fs_write_file", { path, text, expected_mtime: expectedMtime });
export const fsCreateFile = (path: string) => invoke<void>("fs_create_file", { path });
export const fsCreateDir = (path: string) => invoke<void>("fs_create_dir", { path });
export const fsRename = (from: string, to: string) => invoke<void>("fs_rename", { from, to });
export const fsTrash = (paths: string[]) => invoke<void>("fs_trash", { paths });
export const fsReveal = (path: string) => invoke<void>("fs_reveal", { path });
export const fsWatch = (root: string) => invoke<void>("fs_watch", { root });
export const fsUnwatch = (root: string) => invoke<void>("fs_unwatch", { root });

export type FsChanged = { root: string; paths: string[] };

export const onFsChanged = (handler: (e: FsChanged) => void) =>
  tauri.event.listen<FsChanged>("fs-changed", (e) => handler(e.payload));

/** URL for an image preview, served by Tauri's asset protocol (scoped to watched folders). */
export const assetUrl = (path: string) => tauri.core.convertFileSrc(path);

// --- Git ---

export type GitFile = {
  path: string;
  /** Previous path of a staged rename. */
  old_path?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "untracked" | "typechange" | "conflicted";
  staged: boolean;
  added: number;
  removed: number;
};
export type GitStatus = { branch: string; files: GitFile[] };
export type GitDiff = { old_text: string; new_text: string; binary: boolean };

export const gitStatus = (repo: string) => invoke<GitStatus>("git_status", { repo });
export const gitDiffFile = (repo: string, path: string, staged: boolean) =>
  invoke<GitDiff>("git_diff_file", { repo, path, staged });

export const onGitChanged = (handler: (repo: string) => void) =>
  tauri.event.listen<{ repo: string }>("git-changed", (e) => handler(e.payload.repo));

// --- App ---

export const openUrl = (url: string) => invoke<void>("open_url", { url }).catch(() => {});

export const onMenu = (handler: (id: string) => void) => tauri.event.listen<string>("menu", (e) => handler(e.payload));

/** Files dropped on the window, with the drop point in CSS pixels. */
export const onFileDrop = (handler: (paths: string[], x: number, y: number) => void) =>
  tauri.webview.getCurrentWebview().onDragDropEvent((e) => {
    const { type, paths, position } = e.payload;
    if (type !== "drop" || !paths?.length || !position) return;
    handler(paths, position.x / devicePixelRatio, position.y / devicePixelRatio);
  });

export async function pickFolder(): Promise<string | null> {
  const picked = await tauri.dialog.open({ directory: true });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

export const confirmDialog = (title: string, message: string) => tauri.dialog.ask(message, { title, kind: "warning" });

export const closeWindow = () => tauri.window.getCurrentWindow().close();
