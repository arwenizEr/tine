// Pure path helpers (POSIX, absolute paths), free of DOM imports so `node --test` can run them.

/** Drag data type for a file or folder dragged from tine's own tree or folder list. */
export const PATH_MIME = "application/x-tine-path";

export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export const join = (dir: string, name: string): string => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** Resolves `.` and `..`; the result is absolute without a trailing slash. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export const resolve = (base: string, p: string): string => normalize(p.startsWith("/") ? p : `${base}/${p}`);

/** `dir` itself and every ancestor of `p` up to the filesystem root, nearest first. */
export function ancestors(p: string): string[] {
  const out = [p];
  while (out[out.length - 1] !== "/") out.push(dirname(out[out.length - 1]));
  return out;
}

export const isInside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");

export const extension = (p: string): string => {
  const name = basename(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** OSC 7 payload `file://host/path` (percent-encoded) to a path, or null. */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Single-quoted for POSIX shells, safe for any file name. */
export const shellQuote = (p: string): string => `'${p.replaceAll("'", `'\\''`)}'`;

export type PathLink = { start: number; end: number; path: string; line?: number; col?: number };

const PATH_RE = /(?<![\w./~@+-])((?:\.{1,2}\/|\/)?(?:[\w.+@-]+\/)*[\w.+@-]+)(?::(\d+)(?::(\d+))?)?/g;

/**
 * Candidate file paths in one line of terminal output, such as `src/main.rs:12:5` or `./a.txt`.
 * Only shapes that look like paths (a slash, or an extension with a letter) are returned; the caller checks
 * that they exist. URLs are skipped because the character before their path part is `/`.
 */
export function findPathLinks(line: string): PathLink[] {
  const links: PathLink[] = [];
  for (const m of line.matchAll(PATH_RE)) {
    let path = m[1];
    // Sentence punctuation after a path ("see a/b.ts.") is not part of it.
    while (path.length > 1 && path.endsWith(".") && !m[2] && !/(^|\/)\.\.?$/.test(path)) path = path.slice(0, -1);
    if (!path.includes("/") && !/\.\w*[A-Za-z]\w*$/.test(path)) continue;
    if (/^\.+$/.test(path) || /^[\d.]+$/.test(path)) continue; // "..", version numbers
    const start = m.index;
    const end = m[2] ? start + m[0].length : start + path.length;
    links.push({ start, end, path, line: m[2] ? Number(m[2]) : undefined, col: m[3] ? Number(m[3]) : undefined });
  }
  return links;
}
