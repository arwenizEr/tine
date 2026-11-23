import { errorMessage, fsFindFiles, fsSearch } from "../ipc.ts";
import { basename, dirname } from "../paths.ts";
import { openDoc, treeRoot } from "../state/files.ts";
import { repo } from "../state/git.ts";
import { rank } from "./fuzzy.ts";

export type PaletteAction = { label: string; run: () => void };

const LIMIT = 50;

/**
 * Cmd+P: type to open a file from the repo (or the tree's folder); start with ">" for app
 * actions. Cmd+Shift+F opens it in search mode: lines containing the text, across the files.
 * Arrow keys pick, Enter runs, Esc closes.
 */
export function mountPalette(parent: HTMLElement, actions: () => PaletteAction[]) {
  const backdrop = document.createElement("div");
  backdrop.className = "palette-backdrop";
  backdrop.hidden = true;
  const box = document.createElement("div");
  box.className = "palette";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Command palette");
  const input = document.createElement("input");
  input.placeholder = "Open a file, or type > for commands";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  const list = document.createElement("div");
  list.className = "palette-list";
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  box.append(input, list);
  backdrop.append(box);
  parent.append(backdrop);

  let files: string[] = [];
  let root: string | null = null;
  let status = "";
  let items: { label: string; detail: string; run: () => void }[] = [];
  let selectedIndex = 0;
  let restore: HTMLElement | null = null;
  let searching = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchToken = 0;

  const render = () => {
    list.replaceChildren(
      ...items.map((item, i) => {
        const row = document.createElement("div");
        row.className = "palette-item" + (i === selectedIndex ? " selected" : "");
        row.id = `palette-item-${i}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === selectedIndex));
        const label = Object.assign(document.createElement("span"), { className: "palette-label", textContent: item.label });
        const detail = Object.assign(document.createElement("span"), { className: "palette-detail", textContent: item.detail });
        row.append(label, detail);
        row.onmousedown = (e) => e.preventDefault();
        row.onclick = () => choose(i);
        return row;
      }),
    );
    if (!items.length && status) list.append(Object.assign(document.createElement("div"), { className: "palette-empty", textContent: status }));
    input.setAttribute("aria-activedescendant", items.length ? `palette-item-${selectedIndex}` : "");
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };

  /** Search mode: asks the core after a pause in typing; a newer query drops older answers. */
  const search = () => {
    clearTimeout(searchTimer);
    const query = input.value;
    const token = ++searchToken;
    selectedIndex = 0;
    if (!root || query.trim().length < 2) {
      items = [];
      status = !root ? "No folder yet" : "Type at least 2 characters";
      return render();
    }
    const where = root;
    searchTimer = setTimeout(() => {
      status = "Searching…";
      render();
      fsSearch(where, query).then(
        (matches) => {
          if (token !== searchToken) return;
          items = matches.map((m) => ({
            label: m.text,
            detail: `${m.path.slice(where.length + 1)}:${m.line}`,
            run: () => openDoc(m.path, "file", { line: m.line, col: m.col, focus: true }),
          }));
          status = items.length ? "" : "No matches";
          render();
        },
        (e) => {
          if (token !== searchToken) return;
          items = [];
          status = errorMessage(e);
          render();
        },
      );
    }, 200);
  };

  const update = () => {
    if (searching) return search();
    const text = input.value;
    selectedIndex = 0;
    if (text.startsWith(">")) {
      items = rank(text.slice(1), actions(), (a) => a.label, LIMIT).map((a) => ({ label: a.label, detail: "", run: a.run }));
      status = items.length ? "" : "No matching command";
    } else {
      const prefix = root ? root.length + 1 : 0;
      items = rank(text, files, (f) => f.slice(prefix), LIMIT).map((f) => ({
        label: basename(f),
        detail: dirname(f).slice(prefix),
        run: () => openDoc(f, "file", { focus: true }),
      }));
      if (!items.length && !status) status = "No matching file";
    }
    render();
  };

  const close = () => {
    backdrop.hidden = true;
    restore?.focus();
  };

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    close();
    item.run();
  };

  input.oninput = update;
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (items.length) selectedIndex = (selectedIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      choose(selectedIndex);
    } else if (e.key === "Escape") {
      close();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  backdrop.onmousedown = (e) => {
    if (e.target === backdrop) close();
  };

  return {
    open(mode: "files" | "search" = "files") {
      restore = document.activeElement as HTMLElement | null;
      backdrop.hidden = false;
      searching = mode === "search";
      box.setAttribute("aria-label", searching ? "Search in files" : "Command palette");
      input.placeholder = searching ? "Search in files" : "Open a file, or type > for commands";
      input.value = "";
      input.focus();
      // Re-index on every open so new files show up; the last list serves until it arrives.
      const where = repo.get() ?? treeRoot.get();
      if (where !== root) files = [];
      root = where;
      status = !root ? "No folder yet" : files.length ? "" : "Indexing files…";
      if (root) {
        const asked = root;
        fsFindFiles(asked).then(
          (found) => {
            if (root !== asked) return;
            files = found;
            status = "";
            if (!backdrop.hidden && !searching && !input.value.startsWith(">")) update();
          },
          (e) => {
            status = errorMessage(e);
            if (!backdrop.hidden) update();
          },
        );
      }
      update();
    },
  };
}
