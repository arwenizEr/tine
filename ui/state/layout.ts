import { signal } from "../signal.ts";

/** Below this window width the viewer is a drawer over the terminal, not a third column. */
const COMPACT = "(max-width: 1100px)";
export const isCompact = (): boolean => matchMedia(COMPACT).matches;

export const sidebarVisible = signal(true);
export const viewerVisible = signal(!isCompact());

/** What the viewer column shows: open files and diffs, or the web panel. One at a time. */
export const viewerMode = signal<"docs" | "web">("docs");

/** Follow mode: the viewer shows the diff of each file as it changes. */
export const followMode = signal(false);
