export type MenuItem = { label: string; run: () => void } | "separator";

/** A context menu at the pointer; closes on choice, outside click or Escape. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector(".context-menu")?.remove();
  const restore = document.activeElement as HTMLElement | null;
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === "separator") {
      menu.append(Object.assign(document.createElement("hr"), { role: "separator" }));
      continue;
    }
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = item.label;
    b.onclick = () => {
      close();
      item.run();
    };
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;

  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      close();
      restore?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      buttons[(i + step + buttons.length) % buttons.length]?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  function close() {
    menu.remove();
    removeEventListener("mousedown", onDown, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("blur", close);
  }
  addEventListener("mousedown", onDown, true);
  addEventListener("keydown", onKey, true);
  addEventListener("blur", close);
  buttons[0]?.focus();
}
