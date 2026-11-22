import { errorMessage, gitCommit, gitStage, gitStatus, gitUnstage, onGitChanged, type GitFile } from "../ipc.ts";
import { basename, dirname } from "../paths.ts";
import { openDoc } from "../state/files.ts";
import { gitState, repo } from "../state/git.ts";
import { toast } from "../ui/toast.ts";

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
  refreshStatus = refresh;
  return () => {
    unsub();
    void listener.then((u) => u());
  };
}

/** Re-reads git status now, e.g. right after a stage or commit. */
export let refreshStatus: () => Promise<void> = async () => {};

/** Paths git needs to (un)stage a change: both sides of a rename. */
const pathsOf = (f: GitFile) => (f.old_path ? [f.old_path, f.path] : [f.path]);

/** The git panel in the sidebar: staged and unstaged changes, stage buttons and the commit box. */
export function mount(parent: HTMLElement): () => void {
  const stopUpdates = startStatusUpdates();

  const panel = document.createElement("div");
  panel.className = "git-panel";

  const commitBox = document.createElement("div");
  commitBox.className = "git-commit";
  const message = document.createElement("textarea");
  message.rows = 3;
  message.placeholder = navigator.userAgent.includes("Mac") ? "Commit message (⌘↩ to commit)" : "Commit message (Ctrl+Enter to commit)";
  message.setAttribute("aria-label", "Commit message");
  const commitButton = document.createElement("button");
  commitButton.className = "git-commit-button";
  commitButton.textContent = "Commit";
  commitBox.append(message, commitButton);

  const lists = document.createElement("div");
  lists.className = "git-lists";
  panel.append(commitBox, lists);
  parent.append(panel);

  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      toast(errorMessage(e));
    }
    await refreshStatus();
  };

  const commit = () => {
    const r = repo.get();
    if (!r || commitButton.disabled) return;
    void act(async () => {
      const id = await gitCommit(r, message.value);
      message.value = "";
      toast(`Committed ${id.slice(0, 7)}`);
    }).then(update);
  };
  commitButton.onclick = commit;
  message.onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  const update = () => {
    const staged = gitState.get()?.files.some((f) => f.staged) ?? false;
    commitButton.disabled = !staged || message.value.trim() === "";
  };
  message.oninput = update;

  const row = (f: GitFile, r: string) => {
    const el = document.createElement("div");
    el.className = `git-row git-${f.status}`;
    el.tabIndex = 0;
    el.title = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
    const letter = document.createElement("span");
    letter.className = "git-letter";
    letter.textContent = LETTER[f.status];
    letter.title = f.status;
    const name = document.createElement("span");
    name.className = "git-name";
    name.textContent = basename(f.path);
    const dir = document.createElement("span");
    dir.className = "git-dir";
    const rel = dirname(f.path).slice(r.length + 1);
    dir.textContent = rel;
    const counts = document.createElement("span");
    counts.className = "git-counts";
    if (f.added) counts.append(Object.assign(document.createElement("span"), { className: "git-added-count", textContent: `+${f.added}` }));
    if (f.removed) counts.append(Object.assign(document.createElement("span"), { className: "git-removed-count", textContent: `−${f.removed}` }));
    const button = document.createElement("button");
    button.className = "git-action";
    button.textContent = f.staged ? "−" : "+";
    button.setAttribute("aria-label", `${f.staged ? "Unstage" : "Stage"} ${basename(f.path)}`);
    button.title = f.staged ? "Unstage" : "Stage";
    button.onclick = (e) => {
      e.stopPropagation();
      void act(() => (f.staged ? gitUnstage : gitStage)(r, pathsOf(f)));
    };
    const open = (preview: boolean) => openDoc(f.path, "diff", { preview, staged: f.staged });
    el.onclick = () => open(true);
    el.ondblclick = () => open(false);
    el.onkeydown = (e) => {
      if (e.key === "Enter") open(false);
      else if (e.key === " ") open(true);
      else return;
      e.preventDefault();
    };
    el.append(letter, name, dir, counts, button);
    return el;
  };

  const section = (title: string, files: GitFile[], r: string, all: { label: string; run: () => Promise<unknown> }) => {
    const sec = document.createElement("section");
    const head = document.createElement("div");
    head.className = "git-section-head";
    const label = document.createElement("span");
    label.textContent = `${title} (${files.length})`;
    const allButton = document.createElement("button");
    allButton.className = "git-all";
    allButton.textContent = all.label;
    allButton.onclick = () => void act(all.run);
    head.append(label, allButton);
    sec.append(head, ...files.map((f) => row(f, r)));
    return sec;
  };

  const render = () => {
    const st = gitState.get();
    const r = repo.get();
    if (!st || !r) {
      lists.replaceChildren();
      return update();
    }
    const staged = st.files.filter((f) => f.staged);
    const unstaged = st.files.filter((f) => !f.staged);
    const parts: HTMLElement[] = [];
    if (staged.length) {
      parts.push(section("Staged Changes", staged, r, { label: "Unstage All", run: () => gitUnstage(r, staged.flatMap(pathsOf)) }));
    }
    if (unstaged.length) {
      parts.push(section("Changes", unstaged, r, { label: "Stage All", run: () => gitStage(r, unstaged.map((f) => f.path)) }));
    }
    if (!parts.length) {
      parts.push(Object.assign(document.createElement("div"), { className: "git-empty", textContent: "No changes" }));
    }
    lists.replaceChildren(...parts);
    update();
  };

  const unsub = gitState.subscribe(render);
  render();

  return () => {
    unsub();
    stopUpdates();
    panel.remove();
  };
}
