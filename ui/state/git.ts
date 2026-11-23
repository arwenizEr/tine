import type { GitFile, GitStatus } from "../ipc.ts";
import { signal } from "../signal.ts";

/** Working-tree root of the repo the tree shows, or null outside a repo. */
export const repo = signal<string | null>(null);

/** Latest `git_status` for `repo`. */
export const gitState = signal<GitStatus | null>(null);

/** Snapshot of the working tree taken at the last Enter in a terminal: the start of this turn. */
export type Turn = { repo: string; base: string; at: number };
export const turn = signal<Turn | null>(null);

/** Files changed since `turn` started; null until computed. */
export const turnFiles = signal<GitFile[] | null>(null);

/** The branch's whole work against the default branch (`name`); null until computed or outside a repo. */
export const branchChanges = signal<{ repo: string; name: string; base: string; files: GitFile[] } | "none" | null>(null);

/** What the git panel lists: every uncommitted change, this turn's, or the whole branch's. */
export const gitScope = signal<"all" | "turn" | "branch">("all");

/** Which view the sidebar shows. */
export const sidebarView = signal<"files" | "git">("files");
