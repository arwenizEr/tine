// Parsing of the shell integration's escape sequences. Pure, so `node --test` can run it.

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

/** "0.4s", "12s", "3m 05s": short enough for the corner of a block. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
