import { gitState } from "../state/git.ts";

/** Status bar badge: branch, changed file count, lines added and removed. Hidden outside a repo. */
export function mountBadge(parent: HTMLElement, onClick: () => void): () => void {
  const badge = document.createElement("button");
  badge.className = "git-badge";
  badge.onclick = onClick;
  parent.append(badge);

  const render = () => {
    const st = gitState.get();
    badge.hidden = !st;
    if (!st) return;
    const files = new Set(st.files.map((f) => f.path)).size;
    const added = st.files.reduce((n, f) => n + f.added, 0);
    const removed = st.files.reduce((n, f) => n + f.removed, 0);
    const branch = Object.assign(document.createElement("span"), { className: "badge-branch", textContent: `⎇ ${st.branch}` });
    const count = Object.assign(document.createElement("span"), { textContent: files === 1 ? "1 file" : `${files} files` });
    const plus = Object.assign(document.createElement("span"), { className: "git-added-count", textContent: `+${added}` });
    const minus = Object.assign(document.createElement("span"), { className: "git-removed-count", textContent: `−${removed}` });
    badge.replaceChildren(branch, ...(files ? [count, plus, minus] : []));
    badge.setAttribute("aria-label", `Branch ${st.branch}, ${files} changed files, ${added} lines added, ${removed} removed. Open the git panel.`);
  };
  const unsub = gitState.subscribe(render);
  render();
  return () => {
    unsub();
    badge.remove();
  };
}
