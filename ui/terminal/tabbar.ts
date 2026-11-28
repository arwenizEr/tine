import { caio, start as startCaio } from "../caio/index.ts";
import { commands } from "../state/commands.ts";
import { activeTabId, splitPair, tabs } from "../state/tabs.ts";

/** Renders the tab strip from state; clicks call back into the terminal panel. */
export function mountTabBar(
  root: HTMLElement,
  actions: { select(id: number): void; close(id: number): void; create(): void },
): () => void {
  const bar = document.createElement("nav");
  bar.className = "tabbar";
  root.append(bar);

  const render = () => {
    const active = activeTabId.get();
    bar.replaceChildren(
      ...tabs.get().map((tab) => {
        const el = document.createElement("div");
        const shown = tab.id !== active && splitPair.get()?.includes(tab.id);
        el.className = "tab" + (tab.id === active ? " active" : shown ? " shown" : "");
        el.title = tab.title;
        const label = document.createElement("span");
        label.className = "tab-title";
        const sb = tab.sandbox;
        label.textContent = sb ? `${sb.kind === "restricted" ? "🔒" : "📦"} ${tab.title}` : tab.title;
        if (sb?.kind === "restricted") el.title = `${tab.title}\nRestricted: writes only to ${sb.root}`;
        if (sb?.kind === "isolated") el.title = `${tab.title}\nIsolated container: sees only ${sb.root}, as /work`;
        const activity = document.createElement("span");
        activity.className = `tab-activity ${tab.activity}`;
        if (tab.activity !== "idle") {
          activity.setAttribute("role", "img");
          activity.setAttribute("aria-label", { busy: "working", attention: "needs attention", waiting: "waiting for you" }[tab.activity]);
        }
        const close = document.createElement("button");
        close.className = "tab-close";
        close.textContent = "×";
        close.setAttribute("aria-label", `Close ${tab.title}`);
        close.onclick = (e) => {
          e.stopPropagation();
          actions.close(tab.id);
        };
        el.onclick = () => actions.select(tab.id);
        el.append(activity, label, close);
        return el;
      }),
    );
    const add = document.createElement("button");
    add.className = "tab-new";
    add.textContent = "+";
    add.setAttribute("aria-label", "New tab");
    add.onclick = () => actions.create();
    const gear = Object.assign(document.createElement("button"), { className: "settings-button", textContent: "⚙ Settings" });
    gear.onclick = () => commands.openSettings();
    const web = Object.assign(document.createElement("button"), { className: "settings-button web-button", textContent: "◫ Web", title: "Show or close the web panel" });
    web.onclick = () => commands.toggleWeb();
    bar.append(add, web, gear);
    // Only once [caio] path is set: a dot that says whether the docs server answers.
    const docs = caio.get();
    if (docs?.configured) {
      const button = Object.assign(document.createElement("button"), {
        className: "settings-button docs-button",
        textContent: `${docs.up ? "●" : "○"} Docs`,
        title: docs.up ? "Search the local docs (Caio)" : "Caio is not running: click to start it",
      });
      button.onclick = () => (docs.up ? commands.searchDocs() : void startCaio());
      web.before(button);
    }
  };

  const unsubs = [tabs.subscribe(render), activeTabId.subscribe(render), splitPair.subscribe(render), caio.subscribe(render)];
  render();
  return () => {
    unsubs.forEach((u) => u());
    bar.remove();
  };
}
