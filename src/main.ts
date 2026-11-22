import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";
import "./styles/layout.css";
import { mountApp } from "./app.ts";
import { logError, openUrl } from "./ipc.ts";

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
addEventListener("error", (e) => logError(describe(e.error ?? e.message)));
addEventListener("unhandledrejection", (e) => logError(describe(e.reason)));

// No link may navigate the app's own page (it would replace tine with a website): every link,
// in the viewer or Quick Look, opens in the browser instead. open_url allows web and mail only.
for (const type of ["click", "auxclick"]) {
  addEventListener(
    type,
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href && href !== "#") void openUrl(href);
    },
    true,
  );
}

mountApp(document.body);
