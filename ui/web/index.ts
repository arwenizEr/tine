import { promptName } from "../components/prompt.ts";
import { toast } from "../components/toast.ts";
import { toWebUrl } from "../components/weburl.ts";
import { errorMessage, openUrl, settingsSet, webClose, webPlace, webShow } from "../ipc.ts";
import { commands } from "../state/commands.ts";
import { viewerMode, viewerVisible } from "../state/layout.ts";
import { settings } from "../state/settings.ts";

const OPEN = "__open";
const OVERLAYS = ".modal-backdrop, .context-menu, .palette-backdrop:not([hidden]), .quicklook-backdrop:not([hidden])";

const label = (url: string) => {
  const u = new URL(url);
  const rest = (u.pathname + u.search).replace(/^\/$/, "");
  return u.hostname.replace(/^www\./, "") + (rest.length > 30 ? rest.slice(0, 30) + "…" : rest);
};

/**
 * The web panel: the viewer column shows either the open files or a web page (a video, docs)
 * in a native webview that Rust lays over `slot`. Switching to files hides the page but keeps
 * it loaded; × closes it. Bookmarks live in the settings file.
 */
export function mount(parent: HTMLElement): () => void {
  const pane = Object.assign(document.createElement("section"), { className: "web-pane", hidden: true });
  pane.setAttribute("aria-label", "Web");
  const bar = Object.assign(document.createElement("div"), { className: "web-bar" });
  const picker = Object.assign(document.createElement("select"), { className: "web-bookmarks", title: "Bookmarks" });
  picker.setAttribute("aria-label", "Bookmarks");
  const button = (text: string, title: string, run: () => void) => {
    const b = Object.assign(document.createElement("button"), { className: "bar-button", textContent: text, title });
    b.setAttribute("aria-label", title);
    b.onclick = run;
    return b;
  };
  const star = button("☆", "Bookmark this page", () => void toggleBookmark());
  const browser = button("↗", "Open in your browser", () => url && void openUrl(url));
  const files = button("‹ Files", "Back to the open files; the page keeps playing", () => viewerMode.set("docs"));
  const close = button("×", "Close the page", () => closePage());
  bar.append(files, picker, star, browser, close);
  const slot = Object.assign(document.createElement("div"), { className: "web-slot" });
  const hint = Object.assign(document.createElement("div"), { className: "web-hint", textContent: "Choose a bookmark, or Open address… in the menu above." });
  slot.append(hint);
  pane.append(bar, slot);
  parent.append(pane);

  let url: string | null = null;
  let shown = false; // a webview exists for `url`

  const render = () => {
    const marks = settings.get().bookmarks ?? [];
    const head = new Option(url ? label(url) : "Bookmarks…", "");
    head.disabled = true;
    const options = marks.map((m) => new Option(label(m), m));
    picker.replaceChildren(head, ...options, new Option("Open address…", OPEN));
    picker.value = url && marks.includes(url) ? url : "";
    const saved = !!url && marks.includes(url);
    star.textContent = saved ? "★" : "☆";
    star.title = saved ? "Remove this bookmark" : "Bookmark this page";
    star.setAttribute("aria-label", star.title);
    star.disabled = browser.disabled = !url;
    hint.hidden = !!url;
  };

  const rect = () => {
    const r = slot.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  let queued = false;
  const place = () => {
    if (!shown || queued) return;
    queued = true;
    // After the current task, so several triggers in a row cost one move.
    queueMicrotask(() => {
      queued = false;
      if (!shown) return;
      const r = rect();
      const hidden = pane.hidden || !viewerVisible.get() || r.width < 2 || r.height < 2 || !!document.querySelector(OVERLAYS);
      void webPlace({ ...r, hidden }).catch(() => {});
    });
  };

  const go = async (next: string) => {
    url = next;
    render();
    try {
      await webShow(next, rect());
      shown = true;
      place();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const closePage = () => {
    if (shown) void webClose().catch(() => {});
    shown = false;
    viewerMode.set("docs");
  };
  const showMode = (mode: "docs" | "web") => {
    pane.hidden = mode !== "web";
    if (mode === "web" && url && !shown) void go(url);
    place();
  };
  commands.toggleWeb = () => {
    if (viewerMode.get() === "web" && viewerVisible.get()) return viewerMode.set("docs");
    viewerMode.set("web");
    viewerVisible.set(true);
  };

  const saveBookmarks = async (marks: string[]) => {
    try {
      settings.set(await settingsSet("bookmarks", marks.length ? marks : null));
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const toggleBookmark = async () => {
    if (!url) return;
    const marks = settings.get().bookmarks ?? [];
    await saveBookmarks(marks.includes(url) ? marks.filter((m) => m !== url) : [...marks, url]);
  };

  picker.onchange = async () => {
    const choice = picker.value;
    render();
    if (choice !== OPEN) return void (choice && go(choice));
    if (shown) void webPlace({ ...rect(), hidden: true }); // the prompt would be drawn under the page
    const text = await promptName("Open web page", url ?? "", (v) => (toWebUrl(v) ? null : "Enter a web address, such as youtube.com."));
    const next = text && toWebUrl(text);
    if (next) void go(next);
    else place();
  };

  render();
  const resize = new ResizeObserver(place);
  resize.observe(slot);
  // Menus and dialogs come and go as children of <body>; panels hide with the `hidden` attribute.
  const added = new MutationObserver(place);
  added.observe(document.body, { childList: true });
  const toggled = new MutationObserver(place);
  toggled.observe(document.body, { subtree: true, attributeFilter: ["hidden"] });
  addEventListener("resize", place);
  document.addEventListener("animationend", place, true);
  const unsubs = [settings.subscribe(render), viewerVisible.subscribe(place), viewerMode.subscribe(showMode)];

  return () => {
    unsubs.forEach((u) => u());
    resize.disconnect();
    added.disconnect();
    toggled.disconnect();
    removeEventListener("resize", place);
    document.removeEventListener("animationend", place, true);
    commands.toggleWeb = () => {};
    if (shown) void webClose().catch(() => {});
    pane.remove();
  };
}
