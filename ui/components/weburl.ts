/** "youtube.com" or a full http(s) address as a URL to open; null for anything else. */
export function toWebUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  // "localhost:3000" also looks like a scheme; local dev servers rarely speak https.
  const local = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(t);
  const full = local ? `http://${t}` : /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const url = new URL(full);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && (local || url.hostname.includes(".")) ? url.href : null;
  } catch {
    return null;
  }
}
