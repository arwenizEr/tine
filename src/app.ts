import * as terminal from "./terminal/index.ts";

/** Layout: sidebar | terminal | side panel. M1 has only the terminal column. */
export function mountApp(root: HTMLElement): () => void {
  const main = document.createElement("main");
  main.className = "terminal-column";
  root.append(main);
  const disposeTerminal = terminal.mount(main);
  return () => {
    disposeTerminal();
    main.remove();
  };
}
