// The only file that talks to Tauri. Uses the injected `window.__TAURI__` global
// (app.withGlobalTauri) so the frontend needs no @tauri-apps/* npm packages.

type TauriChannel<T> = { onmessage: (message: T) => void };
type Unlisten = () => void;
type DragDropEvent = { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } };
type TauriGlobal = {
  core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    Channel: new <T>() => TauriChannel<T>;
  };
  event: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<Unlisten>;
  };
  window: { getCurrentWindow(): { close(): Promise<void> } };
  webview: { getCurrentWebview(): { onDragDropEvent(handler: (e: DragDropEvent) => void): Promise<Unlisten> } };
  notification: {
    isPermissionGranted(): Promise<boolean>;
    requestPermission(): Promise<string>;
    sendNotification(options: { title: string; body: string }): void;
  };
  dialog: {
    open(options: { directory: boolean }): Promise<string | string[] | null>;
    ask(
      message: string,
      options: { title: string; kind: "warning" | "info"; okLabel?: string; cancelLabel?: string },
    ): Promise<boolean>;
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
  token: string,
  cwd?: string,
): Promise<number> {
  const channel = new tauri.core.Channel<ArrayBuffer>();
  channel.onmessage = (bytes) => onData(new Uint8Array(bytes));
  return invoke("pty_spawn", { cwd, token, cols, rows, on_data: channel });
}

// Commands run concurrently in Rust, so two quick writes could reach the shell out of order.
// Chaining them per PTY keeps keystrokes in the order they were typed.
const writeQueues = new Map<number, Promise<void>>();
export function ptyWrite(ptyId: number, data: string): Promise<void> {
  const prev = writeQueues.get(ptyId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => invoke<void>("pty_write", { pty_id: ptyId, data }));
  writeQueues.set(ptyId, next);
  return next;
}

export const ptyResize = (ptyId: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { pty_id: ptyId, cols, rows });

export function ptyKill(ptyId: number): Promise<void> {
  writeQueues.delete(ptyId);
  return invoke<void>("pty_kill", { pty_id: ptyId });
}

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
/** Every file under `root` that git does not ignore (up to 50,000), for the command palette. */
export const fsFindFiles = (root: string) => invoke<string[]>("fs_find_files", { root });
export type Match = { path: string; line: number; col: number; text: string };
/** Lines containing `query` (any case) in those files, up to 500. */
export const fsSearch = (root: string, query: string) => invoke<Match[]>("fs_search", { root, query });
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

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

/** Shows the image file at `path` in `img`, from its bytes; the blob: URL is freed once it has loaded. */
export async function showImage(img: HTMLImageElement, path: string): Promise<void> {
  const bytes = await invoke<ArrayBuffer>("fs_read_image", { path });
  const type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "";
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  img.onload = img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

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
/** With `base` (a snapshot id), the diff is from that snapshot to the file on disk. */
export const gitDiffFile = (repo: string, path: string, staged: boolean, base?: string) =>
  invoke<GitDiff>("git_diff_file", { repo, path, staged, base });
/** Records the working tree; returns a snapshot id for `gitChangesSince` and `gitDiffFile`. */
export const gitSnapshot = (repo: string) => invoke<string>("git_snapshot", { repo });
/** Where the branch forked from the default branch; `base` works with `gitChangesSince`. */
export const gitBranchBase = (repo: string) => invoke<{ name: string; base: string } | null>("git_branch_base", { repo });
export const gitChangesSince = (repo: string, base: string) => invoke<GitFile[]>("git_changes_since", { repo, base });

export const onGitChanged = (handler: (repo: string) => void) =>
  tauri.event.listen<{ repo: string }>("git-changed", (e) => handler(e.payload.repo));

// --- Settings ---

export type Settings = {
  font_family?: string;
  font_size?: number;
  theme?: "system" | "light" | "dark";
  shell?: string;
  editor?: "vscode" | "cursor" | "zed";
  keybindings: Record<string, string>;
};

/** Reads ~/.config/<app>/settings.toml, creating a commented template the first time. */
export const settingsLoad = () => invoke<{ path: string; settings: Settings }>("settings_load");

/** Sets one top-level setting in the file (null: back to the default); returns the new settings. */
export const settingsSet = (key: string, value: string | number | null) => invoke<Settings>("settings_set", { key, value });

// --- App ---

/** Opens a file at a line in the editor chosen in the settings (VS Code by default). */
export const openInEditor = (path: string, line: number, col: number) => invoke<void>("open_in_editor", { path, line, col });

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

export const logError = (message: string) => void invoke("log_error", { message }).catch(() => {});

/** macOS: whether tine has Full Disk Access, and the System Settings page that grants it. */
const fullDiskAccess = () => invoke<boolean>("full_disk_access");
export const openFullDiskAccessSettings = () => invoke<void>("open_full_disk_access_settings");

/** Asks once, at first start on macOS, for the one grant that covers every protected folder. */
export async function offerFullDiskAccess(): Promise<void> {
  if (await fullDiskAccess()) return;
  const yes = await tauri.dialog.ask(
    "macOS asks separately before tine (and every command you run in it) can open Desktop, Documents, Downloads and other protected folders.\n\nTurn on tine under Full Disk Access once, and macOS stops asking.",
    { title: "Allow access to your files once", kind: "info", okLabel: "Open Settings", cancelLabel: "Not Now" },
  );
  if (yes) await openFullDiskAccessSettings();
}

let notificationsAllowed: Promise<boolean> | null = null;
/** A desktop notification; macOS asks for permission the first time. */
export async function notify(title: string, body: string): Promise<void> {
  const n = tauri.notification;
  notificationsAllowed ??= n
    .isPermissionGranted()
    .then((granted) => granted || n.requestPermission().then((answer) => answer === "granted"))
    .catch(() => false);
  if (await notificationsAllowed) n.sendNotification({ title, body });
}

export const closeWindow = () => tauri.window.getCurrentWindow().close();
