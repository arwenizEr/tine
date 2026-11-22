import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";
import "./styles/layout.css";
import { mountApp } from "./app.ts";
import { logError } from "./ipc.ts";

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
addEventListener("error", (e) => logError(describe(e.error ?? e.message)));
addEventListener("unhandledrejection", (e) => logError(describe(e.reason)));

mountApp(document.body);
