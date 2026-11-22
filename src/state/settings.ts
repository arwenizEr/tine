import type { Settings } from "../ipc.ts";
import { signal } from "../signal.ts";

/** The settings file's values; defaults until it has been read. */
export const settings = signal<Settings>({ keybindings: {} });

/** Where the settings file lives, once known. */
export const settingsPath = signal<string | null>(null);
