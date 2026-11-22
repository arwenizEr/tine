import type { SearchAddon } from "@xterm/addon-search";

const decorations = {
  matchBackground: "#4b4220",
  matchOverviewRuler: "#e5c07b",
  activeMatchBackground: "#9a7a1a",
  activeMatchColorOverviewRuler: "#ffcc00",
};

/**
 * A find bar over the terminal for its scrollback. It lives outside the terminal host, so
 * Shift+Enter in it steps back instead of being sent to the shell.
 */
export function mountSearch(parent: HTMLElement, current: () => { search: SearchAddon; focus(): void } | undefined) {
  const bar = document.createElement("div");
  bar.className = "term-search";
  bar.hidden = true;
  bar.setAttribute("role", "search");
  const input = document.createElement("input");
  input.placeholder = "Find in terminal";
  input.setAttribute("aria-label", "Find in terminal");
  input.spellcheck = false;
  const count = document.createElement("span");
  count.className = "term-search-count";
  count.setAttribute("aria-live", "polite");
  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = run;
    return b;
  };
  const step = (forward: boolean) => {
    const s = current()?.search;
    if (!s || !input.value) return;
    if (forward) s.findNext(input.value, { decorations });
    else s.findPrevious(input.value, { decorations });
  };
  const close = () => {
    bar.hidden = true;
    current()?.search.clearDecorations();
    count.textContent = "";
    current()?.focus();
  };
  bar.append(input, count, button("↑", "Previous match", () => step(false)), button("↓", "Next match", () => step(true)), button("×", "Close", close));
  parent.append(bar);

  input.oninput = () => {
    const s = current()?.search;
    if (!s) return;
    if (input.value) s.findNext(input.value, { incremental: true, decorations });
    else {
      s.clearDecorations();
      count.textContent = "";
    }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") step(!e.shiftKey);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    open() {
      bar.hidden = false;
      input.focus();
      input.select();
      if (input.value) step(true);
    },
    close: () => !bar.hidden && close(),
    /** Called by each tab's addon when its result count changes. */
    showCount(index: number, total: number) {
      count.textContent = total === 0 ? "No results" : index < 0 ? `${total}+` : `${index + 1} of ${total}`;
    },
  };
}
