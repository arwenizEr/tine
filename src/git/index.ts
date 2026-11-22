import { gitStatus, onGitChanged, type GitFile } from "../ipc.ts";
import { basename, dirname } from "../paths.ts";
import { openDoc } from "../state/files.ts";
import { gitState, repo } from "../state/git.ts";

const LETTER: Record<GitFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "U",
  typechange: "T",
  conflicted: "C",
};

/** Keeps `gitState` current. A refresh asked for while one runs is folded into one rerun. */
function startStatusUpdates(): () => void {
  let running = false;
  let again = false;
  const refresh = async () => {
    const r = repo.get();
    if (!r) return gitState.set(null);
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const st = await gitStatus(r);
      if (repo.get() === r) gitState.set(st);
    } catch {
      if (repo.get() === r) gitState.set(null);
    } finally {
      running = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  };
  const unsub = repo.subscribe(() => {
    gitState.set(null);
    void refresh();
  });
  const listener = onGitChanged((r) => {
    if (r === repo.get()) void refresh();
  });
  return () => {
    unsub();
    void listener.then((u) => u());
  };
}


/**
 * The git panel in the sidebar: a read-only review list of staged and unstaged changes.
 * Staging and committing happen in the terminal (or by an agent); the list follows live.
 */
export function mount(parent: HTMLElement): () => void {
  const stopUpdates = startStatusUpdates();
  const panel = document.createElement("div");
  panel.className = "git-panel";
  parent.append(panel);

  const row = (f: GitFile, r: string) => {
    const el = document.createElement("div");
    el.className = `git-row git-${f.status}`;
    el.tabIndex = 0;
    el.title = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
    const letter = Object.assign(document.createElement("span"), { className: "git-letter", textContent: LETTER[f.status], title: f.status });
    const name = Object.assign(document.createElement("span"), { className: "git-name", textContent: basename(f.path) });
    const dir = Object.assign(document.createElement("span"), { className: "git-dir", textContent: dirname(f.path).slice(r.length + 1) });
    const counts = Object.assign(document.createElement("span"), { className: "git-counts" });
    if (f.added) counts.append(Object.assign(document.createElement("span"), { className: "git-added-count", textContent: `+${f.added}` }));
    if (f.removed) counts.append(Object.assign(document.createElement("span"), { className: "git-removed-count", textContent: `−${f.removed}` }));
    const open = (preview: boolean) => openDoc(f.path, "diff", { preview, staged: f.staged });
    el.onclick = () => open(true);
    el.ondblclick = () => open(false);
    el.onkeydown = (e) => {
      if (e.key === "Enter") open(false);
      else if (e.key === " ") open(true);
      else return;
      e.preventDefault();
    };
    el.append(letter, name, dir, counts);
    return el;
  };

  const section = (title: string, files: GitFile[], r: string) => {
    const sec = document.createElement("section");
    const head = Object.assign(document.createElement("div"), { className: "git-section-head", textContent: `${title} (${files.length})` });
    sec.append(head, ...files.map((f) => row(f, r)));
    return sec;
  };

  const render = () => {
    const st = gitState.get();
    const r = repo.get();
    if (!st || !r) return panel.replaceChildren();
    const staged = st.files.filter((f) => f.staged);
    const unstaged = st.files.filter((f) => !f.staged);
    const parts: HTMLElement[] = [];
    if (staged.length) parts.push(section("Staged Changes", staged, r));
    if (unstaged.length) parts.push(section("Changes", unstaged, r));
    if (!parts.length) parts.push(Object.assign(document.createElement("div"), { className: "git-empty", textContent: "No changes" }));
    panel.replaceChildren(...parts);
  };

  const unsub = gitState.subscribe(render);
  render();

  return () => {
    unsub();
    stopUpdates();
    panel.remove();
  };
}
