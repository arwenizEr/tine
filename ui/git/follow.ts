import type { GitFile } from "../ipc.ts";
import { openDoc } from "../state/files.ts";
import { gitState } from "../state/git.ts";
import { followMode, isCompact, viewerVisible } from "../state/layout.ts";

const key = (f: GitFile) => `${f.staged}:${f.path}`;
const signature = (f: GitFile) => `${f.status}:${f.added}:${f.removed}`;

/**
 * Follow mode: whenever git status changes, show the diff of the file that just changed in
 * the preview slot. Never moves focus, so typing in the terminal carries on.
 */
export function startFollow(): () => void {
  // null until a status has been seen: the first status of a repo is a baseline, not a change.
  let previous: Map<string, string> | null = null;
  return gitState.subscribe((st) => {
    const before = previous;
    previous = st ? new Map(st.files.map((f) => [key(f), signature(f)])) : null;
    if (!st || !before || !followMode.get()) return;
    // Working-tree edits are what an agent makes; prefer them over index changes.
    const changed = st.files.filter((f) => before.get(key(f)) !== signature(f)).sort((a, b) => Number(b.staged) - Number(a.staged));
    const latest = changed.at(-1);
    if (!latest || latest.status === "deleted") return;
    openDoc(latest.path, "diff", { preview: true, staged: latest.staged, background: true });
    // On a narrow window the drawer would cover the agent's output; only update it there.
    if (!isCompact()) viewerVisible.set(true);
  });
}
