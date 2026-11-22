// Fuzzy matching for the command palette. Pure, so `node --test` can run it.

/**
 * Scores `query` as a subsequence of `text`, or null if it is not one. Consecutive letters,
 * letters at word starts and letters in the file name (after the last "/") score higher;
 * shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 0;
  const nameStart = t.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === prev + 1 ? 5 : 1;
    if (i >= nameStart) score += 2;
    if (i === 0 || "/._- ".includes(t[i - 1])) score += 3;
    prev = i;
    from = i + 1;
  }
  return score - t.length * 0.01;
}

/** The best `limit` items for `query`, best first. */
export function rank<T>(query: string, items: T[], text: (item: T) => string, limit: number): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
