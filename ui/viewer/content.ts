import { fsReadFile, fsStat, type Stat } from "../ipc.ts";
import { extension } from "../paths.ts";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const IMAGE_LIMIT = 20 * 1024 * 1024;

/** What the viewer shows for a path, decided by kind, extension and contents. */
export type Content =
  | { type: "dir" }
  | { type: "image"; stat: Stat }
  | { type: "text"; text: string; truncated: boolean; mtime: number; markdown: boolean }
  | { type: "info"; stat: Stat; reason: string };

export async function loadContent(path: string): Promise<Content> {
  const stat = await fsStat(path);
  if (stat.kind === "dir") return { type: "dir" };
  const ext = extension(path);
  if (IMAGE_EXT.has(ext)) {
    return stat.size > IMAGE_LIMIT ? { type: "info", stat, reason: "Image larger than 20 MB" } : { type: "image", stat };
  }
  if (stat.kind !== "file") return { type: "info", stat, reason: "Not a regular file" };
  const file = await fsReadFile(path);
  if (file.binary) return { type: "info", stat, reason: "Binary file" };
  return { type: "text", text: file.text, truncated: file.truncated, mtime: file.mtime, markdown: MARKDOWN_EXT.has(ext) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatDate = (ms: number) => dateFormat.format(ms);

/** A name, size and date card for files the viewer cannot show. */
export function infoCard(name: string, stat: Stat | null, reason: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "info-card";
  const title = document.createElement("div");
  title.className = "info-name";
  title.textContent = name;
  const why = document.createElement("div");
  why.className = "info-reason";
  why.textContent = reason;
  card.append(title, why);
  if (stat) {
    const meta = document.createElement("div");
    meta.className = "info-meta";
    meta.textContent = `${formatSize(stat.size)} · Modified ${formatDate(stat.mtime)}`;
    card.append(meta);
  }
  return card;
}
