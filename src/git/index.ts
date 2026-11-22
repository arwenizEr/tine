import { gitChangesSince, gitSnapshot, gitStatus, onGitChanged, type GitFile } from "../ipc.ts";
import { basename, dirname } from "../paths.ts";
import { openDoc } from "../state/files.ts";
import { commands } from "../state/commands.ts";
import { gitScope, gitState, repo, turn, turnFiles } from "../state/git.ts";

const LETTER: Record<GitFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "U",
  typechange: "T",
  conflicted: "C",
};

/** Runs `task` now, or once more after the current run if one is in flight. */
function coalesced(task: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  return () => void run();
}

/** Keeps `gitState` and `turnFiles` current, and snapshots the working tree when a turn starts. */
function startStatusUpdates(): () => void {
  const refreshStatus = coalesced(async () => {
    const r = repo.get();
    if (!r) return gitState.set(null);
    const st = await gitStatus(r).catch(() => null);
    if (repo.get() === r) gitState.set(st);
  });
  const refreshTurn = coalesced(async () => {
    const t = turn.get();
    if (!t || t.repo !== repo.get()) return turnFiles.set(null);
    const files = await gitChangesSince(t.repo, t.base).catch(() => null);
    if (turn.get() === t) turnFiles.set(files);
  });

  // One snapshot per Enter, at most once a second: holding Enter must not flood git.
  let lastSnapshot = 0;
  commands.turnStarted = () => {
    const r = repo.get();
    const now = Date.now();
    if (!r || now - lastSnapshot < 1000) return;
    lastSnapshot = now;
    void gitSnapshot(r).then(
      (base) => {
        if (repo.get() === r) turn.set({ repo: r, base, at: now });
      },
      () => {},
    );
  };

  const unsubs = [
    repo.subscribe(() => {
      gitState.set(null);
      turn.set(null);
      refreshStatus();
    }),
    turn.subscribe(refreshTurn),
  ];
  const listener = onGitChanged((r) => {
    if (r !== repo.get()) return;
    refreshStatus();
    refreshTurn();
  });
  return () => {
    unsubs.forEach((u) => u());
    commands.turnStarted = () => {};
    void listener.then((u) => u());
  };
}


/**
 * The git panel in the sidebar: a read-only review list of staged and unstaged changes.
 * Staging and committing happen in the terminal (or by an agent); the list follows live.
 */
export function mount(parent: HTMLElement): () => void {
  const stopUpdates = startStatusUpdates();
  const scope = document.createElement("div");
  scope.className = "git-scope";
  scope.setAttribute("role", "group");
  scope.setAttribute("aria-label", "Changes to list");
  const scopeButton = (value: "all" | "turn", label: string, title: string) => {
    const b = Object.assign(document.createElement("button"), { textContent: label, title });
    b.onclick = () => gitScope.set(value);
    return b;
  };
  const allButton = scopeButton("all", "All", "Every uncommitted change");
  const turnButton = scopeButton("turn", "This Turn", "Only what changed since you last pressed Enter in a terminal");
  scope.append(allButton, turnButton);
  const panel = document.createElement("div");
  panel.className = "git-panel";
  parent.append(scope, panel);

  const row = (f: GitFile, r: string, base?: string) => {
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
    const open = (preview: boolean) => openDoc(f.path, "diff", { preview, staged: f.staged, base });
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

  const section = (title: string, files: GitFile[], r: string, base?: string) => {
    const sec = document.createElement("section");
    const head = Object.assign(document.createElement("div"), { className: "git-section-head", textContent: `${title} (${files.length})` });
    sec.append(head, ...files.map((f) => row(f, r, base)));
    return sec;
  };

  const empty = (text: string) => Object.assign(document.createElement("div"), { className: "git-empty", textContent: text });

  const render = () => {
    allButton.setAttribute("aria-pressed", String(gitScope.get() === "all"));
    turnButton.setAttribute("aria-pressed", String(gitScope.get() === "turn"));
    const st = gitState.get();
    const r = repo.get();
    if (!st || !r) return panel.replaceChildren();
    if (gitScope.get() === "turn") {
      const t = turn.get();
      const files = turnFiles.get();
      if (!t) return panel.replaceChildren(empty("Press Enter in a terminal to start a turn."));
      const since = new Date(t.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      if (!files) return panel.replaceChildren();
      return panel.replaceChildren(
        files.length ? section(`Since ${since}`, files, r, t.base) : empty(`No changes since ${since}`),
      );
    }
    const staged = st.files.filter((f) => f.staged);
    const unstaged = st.files.filter((f) => !f.staged);
    const parts: HTMLElement[] = [];
    if (staged.length) parts.push(section("Staged Changes", staged, r));
    if (unstaged.length) parts.push(section("Changes", unstaged, r));
    if (!parts.length) parts.push(empty("No changes"));
    panel.replaceChildren(...parts);
  };

  const unsubs = [gitState.subscribe(render), turn.subscribe(render), turnFiles.subscribe(render), gitScope.subscribe(render)];
  render();

  return () => {
    unsubs.forEach((u) => u());
    scope.remove();
    stopUpdates();
    panel.remove();
  };
}
