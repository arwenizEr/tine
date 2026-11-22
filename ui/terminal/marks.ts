// Parsing of the shell integration's escape sequences. Pure, so `node --test` can run it.

/**
 * The payload without its `;tine=<token>` suffix, or null when the suffix is missing or wrong.
 * Only the shell integration knows the session's token, so output that merely prints marks
 * (a file being cat'ed, a remote host) cannot pass for the shell sitting at its prompt.
 */
export function signedBy(data: string, token: string): string | null {
  const suffix = `;tine=${token}`;
  return data.endsWith(suffix) ? data.slice(0, -suffix.length) : null;
}

/** OSC 133 payloads: A prompt start, B input start, C command start, D command end (+ exit code). */
export type Mark = { kind: "A" | "B" | "C" } | { kind: "D"; exit: number | null };

export function parseMark(data: string): Mark | null {
  const [kind, arg] = data.split(";");
  if (kind === "A" || kind === "B" || kind === "C") return { kind };
  if (kind !== "D") return null;
  const exit = arg === undefined || arg === "" ? null : Number(arg);
  return { kind: "D", exit: Number.isInteger(exit) ? exit : null };
}

/** OSC 633;E carries the command line percent-encoded; undo that, keeping it as-is if malformed. */
export function decodeCommand(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * A desktop notification for text a program sent (OSC 9, the bell). Any program can send it,
 * so the title always names tine and the tab, and the text is flattened and capped: it cannot
 * pass for a system or other app's alert, nor hide lines.
 */
export function notification(tabTitle: string, message: string): { title: string; body: string } {
  const clean = (s: string, max: number) => {
    const flat = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const tab = clean(tabTitle, 40);
  return { title: tab ? `tine · ${tab}` : "tine", body: clean(message, 200) };
}

/** "0.4s", "12s", "3m 05s": short enough for the corner of a block. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
