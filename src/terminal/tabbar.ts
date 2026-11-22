import { activeTabId, tabs } from "../state/tabs.ts";

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
        el.className = "tab" + (tab.id === active ? " active" : "");
        el.title = tab.title;
        const label = document.createElement("span");
        label.className = "tab-title";
        label.textContent = tab.title;
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
    bar.append(add);
  };

  const unsubs = [tabs.subscribe(render), activeTabId.subscribe(render)];
  render();
  return () => {
    unsubs.forEach((u) => u());
    bar.remove();
  };
}
