// CompactAIO ("Caio"), the local docs server: its status for the tab bar, and its answers
// shown as Markdown in the viewer. The calls go through Rust (core/src/caio.rs).
import { caioCall, caioIndex, caioNote, caioStart, caioStatus, caioConnect, errorMessage, type CaioStatus } from "../ipc.ts";
import { signal } from "../signal.ts";
import { openDoc } from "../state/files.ts";
import { toast } from "../components/toast.ts";
import { answerMarkdown, parseQuery, searchMarkdown } from "./format.ts";

/** Null until the first check. */
export const caio = signal<CaioStatus | null>(null);

export async function refresh(): Promise<void> {
  caio.set(await caioStatus().catch(() => ({ configured: false, up: false })));
}

async function show(markdown: string): Promise<void> {
  openDoc(await caioNote(markdown), "file", { preview: true, focus: true });
}

/** Runs `work`, turning a failure into a toast; a stopped server refreshes the badge. */
async function attempt(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    toast(errorMessage(e));
    void refresh();
  }
}

export const searchDocs = (input: string, projectDir: string | null) =>
  attempt(async () => {
    const { query, library } = parseQuery(input);
    const a = await caioCall("search_docs", { query, ...(library && { library }), ...(projectDir && { project_dir: projectDir }) });
    await show(searchMarkdown(a));
  });

/** `input` is "package symbol", as in "zod string" or "hono Hono.get". */
export const checkSymbol = (input: string, projectDir: string | null) =>
  attempt(async () => {
    const [pkg, symbol] = input.trim().split(/\s+/, 2);
    if (!pkg || !symbol) return toast("Type a package and a symbol, as in: zod string");
    const a = await caioCall("check_symbol", { package: pkg, symbol, ...(projectDir && { project_dir: projectDir }) });
    await show(answerMarkdown(`${pkg} · ${symbol}`, a));
  });

export const start = () =>
  attempt(async () => {
    toast("Starting Caio…");
    await caioStart();
    await refresh();
    toast(caio.get()?.up ? "Caio is running." : "Caio is starting; it answers once its database is up.");
  });

export const connect = () =>
  attempt(async () => {
    const report = await caioConnect();
    toast(report.join("\n"));
  });

export const index = (dir: string) =>
  attempt(async () => {
    toast(`Indexing the dependencies of ${dir}… this takes a few minutes.`);
    toast(await caioIndex(dir));
  });
