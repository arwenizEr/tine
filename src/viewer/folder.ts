import { errorMessage, fsListDir, fsStat, type Kind } from "../ipc.ts";
import { join, PATH_MIME } from "../paths.ts";
import { formatDate, formatSize } from "./content.ts";

const LIMIT = 1000;
const STAT_WORKERS = 16;

/**
 * Lists a folder (folders first) with size and modified date, like Finder's list view.
 * Returns a cancel function; sizes and dates fill in as they arrive.
 */
export function renderFolder(host: HTMLElement, path: string, onPick: (path: string, kind: Kind) => void): () => void {
  let cancelled = false;
  host.replaceChildren(Object.assign(document.createElement("div"), { className: "folder-summary", textContent: "Loading…" }));

  void fsListDir(path).then(
    (entries) => {
      if (cancelled) return;
      const shown = entries.slice(0, LIMIT);
      const summary = document.createElement("div");
      summary.className = "folder-summary";
      summary.textContent =
        entries.length > LIMIT
          ? `Showing the first ${LIMIT.toLocaleString()} of ${entries.length.toLocaleString()} items`
          : `${entries.length.toLocaleString()} item${entries.length === 1 ? "" : "s"}`;

      const table = document.createElement("table");
      table.className = "folder-list";
      const head = table.createTHead().insertRow();
      for (const label of ["Name", "Size", "Modified"]) head.append(Object.assign(document.createElement("th"), { textContent: label }));
      const body = table.createTBody();
      const cells = shown.map((e) => {
        const row = body.insertRow();
        row.className = e.ignored ? "ignored" : "";
        row.tabIndex = -1;
        const name = row.insertCell();
        const icon = document.createElement("span");
        icon.className = `tree-icon ${e.kind}`;
        name.append(icon, e.name);
        const size = row.insertCell();
        const date = row.insertCell();
        row.onclick = () => onPick(join(path, e.name), e.kind);
        row.draggable = true;
        row.ondragstart = (ev) => {
          ev.dataTransfer?.setData(PATH_MIME, join(path, e.name));
          ev.dataTransfer?.setData("text/plain", join(path, e.name));
        };
        return { size, date };
      });
      host.replaceChildren(summary, table);

      let next = 0;
      const worker = async () => {
        while (next < shown.length && !cancelled) {
          const i = next++;
          const stat = await fsStat(join(path, shown[i].name)).catch(() => null);
          if (!stat || cancelled) continue;
          cells[i].size.textContent =
            stat.kind === "dir" ? `${stat.item_count ?? 0} item${stat.item_count === 1 ? "" : "s"}` : formatSize(stat.size);
          cells[i].date.textContent = formatDate(stat.mtime);
        }
      };
      for (let w = 0; w < STAT_WORKERS; w++) void worker();
    },
    (e) => {
      if (!cancelled) host.replaceChildren(Object.assign(document.createElement("div"), { className: "folder-summary", textContent: errorMessage(e) }));
    },
  );
  return () => {
    cancelled = true;
  };
}
