import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

/**
 * Reads a customer's public website, only with their consent, and safely:
 * - http/https on ports 80/443 only, no credentials in URLs
 * - every DNS answer is checked, and the connection is pinned to the checked
 *   address, so a hostname can't be pointed at our internal network (SSRF,
 *   DNS rebinding); redirects are followed by hand and re-checked
 * - robots.txt is honored, pages are capped in count, size and time
 * The text that comes back is untrusted data. Agents are told so.
 */
export const USER_AGENT = "BlogsOnTapBot/1.0 (+https://blogsontap.com)";
const MAX_PAGES = 8;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 12_000;

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96],
  ["2001:db8::", 32]] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

export class UnsafeUrlError extends Error {}

/** Shape check before any network access. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError("only http and https");
  if (u.username || u.password) throw new UnsafeUrlError("credentials in URL");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("non-standard port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError("private address");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new UnsafeUrlError("local hostname");
  u.hash = "";
  return u;
}

type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

export type FetchedPage = { url: string; status: number; contentType: string; body: string };

/** One request to an already-checked URL, pinned to a verified public IP. */
async function requestOnce(u: URL, lookup: LookupFn): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) {
    throw new UnsafeUrlError("hostname resolves to a private address");
  }
  const pinned = addrs[0];
  const mod = u.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.8", "Accept-Encoding": "identity" },
      timeout: TIMEOUT_MS,
      lookup: (_h, _o, cb) => (cb as (e: Error | null, a: string, f: number) => void)(null, pinned.address, pinned.family),
    }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(raw: string, lookup: LookupFn = defaultLookup): Promise<FetchedPage> {
  let u = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(u, lookup);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      u = checkUrl(new URL(String(res.headers.location), u).toString());
      continue;
    }
    return { url: u.toString(), status: res.status, contentType: String(res.headers["content-type"] ?? ""), body: res.body };
  }
  throw new Error("too many redirects");
}

// ---------------------------------------------------------------------------
// robots.txt (the subset that matters: groups for * or our bot, Allow/Disallow prefixes)
// ---------------------------------------------------------------------------
export function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (val) current.rules.push({ allow: key === "allow", prefix: val.replace(/\*$/, "") });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && USER_AGENT.toLowerCase().startsWith(a)));
  const applicable = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (path.startsWith(r.prefix) && (!best || r.prefix.length > best.len || (r.prefix.length === best.len && r.allow))) {
        best = { allow: r.allow, len: r.prefix.length };
      }
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// HTML to text, and link discovery
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "..." };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export function htmlToText(html: string): { title: string; description: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const description = decode(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "").trim();
  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|iframe|template|form|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<h([1-6])\b[^>]*>/gi, "\n## ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
  return { title, description, text };
}

const PRIORITY = /about|service|product|offer|what-we-do|faq|team|location|area|pricing|why|work|contact|blog|news|article/i;

export function discoverLinks(html: string, base: URL): string[] {
  const seen = new Set<string>();
  const out: { url: string; score: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    let u: URL;
    try {
      u = new URL(decode(m[1]), base);
    } catch {
      continue;
    }
    if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    u.search = "";
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key) || key === base.toString().replace(/\/$/, "")) continue;
    seen.add(key);
    const depth = u.pathname.split("/").filter(Boolean).length;
    out.push({ url: u.toString(), score: (PRIORITY.test(u.pathname) ? 0 : 10) + depth });
  }
  return out.sort((a, b) => a.score - b.score).map((x) => x.url);
}

export type CrawledPage = { url: string; title: string; description: string; text: string };

export async function crawlSite(
  startUrls: string[], opts: { lookup?: LookupFn; maxPages?: number } = {},
): Promise<{ pages: CrawledPage[]; skipped: { url: string; reason: string }[] }> {
  const lookup = opts.lookup ?? defaultLookup;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const pages: CrawledPage[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const robotsCache = new Map<string, string>();
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const s of startUrls) {
    try {
      queue.push(checkUrl(s).toString());
    } catch (e) {
      skipped.push({ url: s, reason: (e as Error).message });
    }
  }

  while (queue.length && pages.length < maxPages) {
    const next = queue.shift()!;
    const key = next.replace(/\/$/, "");
    if (visited.has(key)) continue;
    visited.add(key);
    const u = new URL(next);

    if (!robotsCache.has(u.origin)) {
      let robots = "";
      try {
        const r = await safeFetch(`${u.origin}/robots.txt`, lookup);
        if (r.status === 200) robots = r.body.slice(0, 100_000);
      } catch {
        // No robots.txt reachable: treat as allowed.
      }
      robotsCache.set(u.origin, robots);
    }
    if (!robotsAllows(robotsCache.get(u.origin)!, u.pathname)) {
      skipped.push({ url: next, reason: "blocked by robots.txt" });
      continue;
    }

    try {
      const page = await safeFetch(next, lookup);
      if (page.status !== 200) {
        skipped.push({ url: next, reason: `HTTP ${page.status}` });
        continue;
      }
      if (!/text\/html|text\/plain/i.test(page.contentType)) {
        skipped.push({ url: next, reason: `not a web page (${page.contentType || "unknown type"})` });
        continue;
      }
      const t = htmlToText(page.body);
      if (t.text.length > 80) pages.push({ url: page.url, ...t });
      for (const link of discoverLinks(page.body, new URL(page.url))) {
        if (!visited.has(link.replace(/\/$/, ""))) queue.push(link);
      }
    } catch (e) {
      skipped.push({ url: next, reason: (e as Error).message.slice(0, 200) });
    }
  }
  return { pages, skipped };
}
