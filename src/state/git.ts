import type { GitStatus } from "../ipc.ts";
import { signal } from "../signal.ts";

/** Working-tree root of the repo the tree shows, or null outside a repo. */
export const repo = signal<string | null>(null);

/** Latest `git_status` for `repo`. */
export const gitState = signal<GitStatus | null>(null);

/** Which view the sidebar shows. */
export const sidebarView = signal<"files" | "git">("files");
