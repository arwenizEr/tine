import { EditorView } from "@codemirror/view";
import { assetUrl, errorMessage } from "../ipc.ts";
import { basename } from "../paths.ts";
import { quickLook, selected } from "../state/files.ts";
import { infoCard, loadContent } from "./content.ts";
import { createState } from "./editor.ts";
import { renderMarkdown } from "./markdown.ts";

/**
 * Space in the tree: a Quick Look-style overlay centred over the window. It follows the
 * selection, and focus stays in the tree so the arrow keys keep working underneath.
 */
export function mount(parent: HTMLElement): () => void {
  const backdrop = document.createElement("div");
  backdrop.className = "quicklook-backdrop";
  backdrop.hidden = true;
  const panel = document.createElement("div");
  panel.className = "quicklook";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Quick Look");
  const title = document.createElement("div");
  title.className = "quicklook-title";
  const content = document.createElement("div");
  content.className = "quicklook-content";
  panel.append(title, content);
  backdrop.append(panel);
  parent.append(backdrop);

  let view: EditorView | null = null;
  let token = 0;

  const show = async () => {
    const sel = selected.get();
    if (!quickLook.get() || !sel) {
      backdrop.hidden = true;
      return;
    }
    backdrop.hidden = false;
    title.textContent = basename(sel.path);
    const t = ++token;
    try {
      const c = await loadContent(sel.path);
      if (t !== token) return; // the selection moved on
      if (c.type === "dir") {
        content.replaceChildren(infoCard(basename(sel.path), null, "Folder"));
      } else if (c.type === "info") {
        content.replaceChildren(infoCard(basename(sel.path), c.stat, c.reason));
      } else if (c.type === "image") {
        const img = document.createElement("img");
        img.alt = basename(sel.path);
        img.src = `${assetUrl(sel.path)}?v=${c.stat.mtime}`;
        content.replaceChildren(img);
      } else if (c.markdown) {
        const article = document.createElement("article");
        article.className = "doc-markdown";
        article.innerHTML = renderMarkdown(c.text);
        content.replaceChildren(article);
      } else {
        const state = await createState(sel.path, c.text, { editable: false });
        if (t !== token) return;
        view ??= new EditorView({ state });
        view.setState(state);
        content.replaceChildren(view.dom);
      }
    } catch (e) {
      if (t === token) content.replaceChildren(infoCard(basename(sel.path), null, errorMessage(e)));
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && quickLook.get()) {
      quickLook.set(false);
      e.preventDefault();
    }
  };
  addEventListener("keydown", onKey, true);
  backdrop.onmousedown = (e) => {
    if (e.target === backdrop) quickLook.set(false);
  };

  const unsubs = [
    quickLook.subscribe(() => void show()),
    selected.subscribe(() => {
      clearTimeout(timer);
      if (quickLook.get()) timer = setTimeout(() => void show(), 50);
    }),
  ];

  return () => {
    unsubs.forEach((u) => u());
    clearTimeout(timer);
    removeEventListener("keydown", onKey, true);
    view?.destroy();
    backdrop.remove();
  };
}
