// Caio answers turned into Markdown for the viewer. Pure, so it is tested without Tauri.

export type Answer = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** "zod: string min length" searches zod only; without a "name:" prefix, everything. */
export function parseQuery(input: string): { query: string; library?: string } {
  const m = /^([@\w][\w./@-]*):\s*(.+)$/.exec(input.trim());
  return m ? { library: m[1], query: m[2] } : { query: input.trim() };
}

/** A search_docs answer as Markdown: one section per result, with its source and verification. */
export function searchMarkdown(a: Answer): string {
  const head = [`# ${str(a.query)}`, ""];
  if (a.library) head.push(`${str(a.library)} ${str(a.version)} · version from ${str(a.versionSource)}`, "");
  for (const n of [a.note, a.notice]) if (n) head.push(`> ${str(n)}`, "");
  const results = Array.isArray(a.results) ? (a.results as Answer[]) : [];
  if (results.length === 0) head.push("Nothing found.");
  const body = results.map((r) =>
    [`## ${str(r.title)}`, "", `${str(r.library)} ${str(r.version)} · ${str(r.verification)} · [source](${str(r.sourceUrl)})`, "", str(r.content), ""].join("\n"),
  );
  return [...head, ...body].join("\n");
}

/** Any other answer (check_symbol, get_endpoint): fields as a list, code-like ones in blocks. */
export function answerMarkdown(title: string, a: Answer): string {
  const lines = [`# ${title}`, ""];
  for (const [key, value] of Object.entries(a)) {
    const text = str(value);
    if (text.includes("\n") || key === "signature") lines.push(`**${key}**`, "", "```ts", text, "```", "");
    else lines.push(`- **${key}**: ${text}`);
  }
  return lines.join("\n");
}

