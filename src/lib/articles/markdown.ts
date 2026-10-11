/**
 * The only path from AI text to HTML. Writers produce Markdown in a small
 * subset; this renderer escapes everything first and then rebuilds just
 * headings, paragraphs, lists, bold, italic and links. Raw HTML in the input
 * is shown as text, never executed, and links must use http(s) or mailto/tel.
 * Shared by server and browser code: no Node imports.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;

export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
  if (/^\/[^/]/.test(u)) return u;   // site-relative path
  return null;
}

/** Normalize a URL for comparing against the allowed list (no hash, no trailing slash, lowercase host). */
export function normUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * Keep only links whose target is on the allowed list (the customer's own
 * pages, their CTA destination). Anything else keeps its text, loses the link.
 */
export function filterLinks(markdown: string, allowed: string[]): { markdown: string; removed: string[] } {
  const ok = new Set(allowed.map(normUrl));
  const removed: string[] = [];
  const out = markdown.replace(LINK, (_all, text: string, url: string) => {
    const href = safeHref(url);
    const pass = href && (/^(mailto:|tel:)/i.test(href) ? ok.has(href) || ok.has(normUrl(href)) : ok.has(normUrl(href)));
    if (pass) return `[${text}](${url})`;
    removed.push(url);
    return text;
  });
  return { markdown: out, removed };
}

function inline(text: string): string {
  // Links first (on the raw text), then escape everything around them.
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    parts.push(fmt(text.slice(last, m.index)));
    const href = safeHref(m[2]);
    parts.push(href ? `<a href="${escapeHtml(href)}">${fmt(m[1])}</a>` : fmt(m[1]));
    last = m.index! + m[0].length;
  }
  parts.push(fmt(text.slice(last)));
  return parts.join("");
}

function fmt(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.max(2, Math.min(4, h[1].length));   // the article title is the only h1
      html.push(`<h${level}>${inline(h[2].replace(/\s*#+\s*$/, ""))}</h${level}>`);
    } else if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += " " + line.trim();   // wrapped list item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return html.join("\n");
}

export function wordCount(markdown: string): number {
  const text = markdown.replace(LINK, "$1").replace(/[#*`>_-]+/g, " ");
  return (text.match(/[A-Za-z0-9À-ɏ'’]+/g) ?? []).length;
}

export function headings(markdown: string): string[] {
  return markdown.split("\n").map((l) => l.match(/^#{2,4}\s+(.+)$/)?.[1]?.trim()).filter((x): x is string => !!x);
}
