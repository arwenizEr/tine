// The only file that talks to Tauri. Uses the injected `window.__TAURI__` global
// (app.withGlobalTauri) so the frontend needs no @tauri-apps/api dependency.

type TauriChannel<T> = { onmessage: (message: T) => void };
type TauriGlobal = {
  core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    Channel: new <T>() => TauriChannel<T>;
  };
  event: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  };
  window: { getCurrentWindow(): { close(): Promise<void> } };
};

const tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
const { invoke } = tauri.core;

/** Shape of every command error. */
export type AppError = { code: string; message: string };

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

export const ptyWrite = (ptyId: number, data: string) =>
  invoke<void>("pty_write", { pty_id: ptyId, data });

export const ptyResize = (ptyId: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { pty_id: ptyId, cols, rows });

export const ptyKill = (ptyId: number) => invoke<void>("pty_kill", { pty_id: ptyId });

export type PtyExit = { pty_id: number; code: number | null };

export const onPtyExit = (handler: (e: PtyExit) => void) =>
  tauri.event.listen<PtyExit>("pty-exit", (e) => handler(e.payload));

export const openUrl = (url: string) => invoke<void>("open_url", { url }).catch(() => {});

export const closeWindow = () => tauri.window.getCurrentWindow().close();
