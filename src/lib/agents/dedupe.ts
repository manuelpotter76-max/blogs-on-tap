/**
 * Keeps topics fresh: no repeats of earlier topics (any status), of articles
 * the customer already published, or of each other within a batch. Cheap,
 * deterministic word-overlap checks; embeddings can replace this later.
 */
const STOP = new Set(("a an and are as at be best by can do does for from get guide how i in into is it its "
  + "my of on or our should the their them these this to top ultimate vs what when where which who why will with "
  + "you your yours tips ways things need know").split(" "));

export function words(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

/** Just enough stemming to match "fixing"/"fix", "leaks"/"leak", "repairs"/"repair", "costs"/"cost". */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** Stable key: the meaningful words, sorted. "10 Ways to Fix a Leaky Faucet" = "fix faucet leaky". */
export function topicKey(title: string): string {
  return [...new Set(words(title))].sort().join(" ") || title.toLowerCase().trim();
}

export function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const SIMILAR = 0.6;

export type Candidate = { title: string; primary_keyword: string };
export type Known = { title: string; primary_keyword?: string | null };

/** Splits candidates into kept and dropped, with the reason for each drop. */
export function filterFresh<T extends Candidate>(candidates: T[], known: Known[]): { kept: T[]; dropped: { title: string; reason: string }[] } {
  const kept: T[] = [];
  const dropped: { title: string; reason: string }[] = [];
  const keys = new Set(known.map((k) => topicKey(k.title)));
  const keywords = new Set(known.map((k) => (k.primary_keyword ?? "").toLowerCase().trim()).filter(Boolean));

  for (const c of candidates) {
    const key = topicKey(c.title);
    const kw = c.primary_keyword.toLowerCase().trim();
    const pool: Known[] = [...known, ...kept];
    const near = pool.find((k) => similarity(k.title, c.title) >= SIMILAR);
    if (keys.has(key)) dropped.push({ title: c.title, reason: "repeats an earlier topic" });
    else if (kw && keywords.has(kw)) dropped.push({ title: c.title, reason: `same keyword as an earlier topic ("${kw}")` });
    else if (near) dropped.push({ title: c.title, reason: `too close to "${near.title}"` });
    else {
      kept.push(c);
      keys.add(key);
      if (kw) keywords.add(kw);
    }
  }
  return { kept, dropped };
}
