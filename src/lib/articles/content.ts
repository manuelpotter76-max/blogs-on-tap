import { arr, obj, str, type Schema } from "@/lib/ai/json-schema";
import type { BusinessProfile } from "@/lib/agents/business-profile";
import { filterLinks, headings, wordCount } from "./markdown";

/** What every finished article carries (acceptance test 13). */
export type ArticleContent = {
  seo_title: string;
  meta_description: string;
  slug: string;
  excerpt: string;
  markdown: string;
  tags: string[];
  categories: string[];
  internal_links: { anchor: string; url: string; why: string }[];
  cta: string;
  source_notes: { claim: string; source: string }[];
};

export const ARTICLE_SCHEMA: Schema = obj({
  seo_title: str("Under 60 characters, specific, no clickbait"),
  meta_description: str("120 to 155 characters, plain and accurate"),
  slug: str("lowercase-words-with-hyphens"),
  excerpt: str("One or two sentences for blog listings"),
  markdown: str("The article body in Markdown. Start with an intro paragraph, then ## and ### headings. No title line, no HTML."),
  tags: arr(str(), undefined, 8),
  categories: arr(str(), undefined, 3),
  internal_links: arr(obj({
    anchor: str("Link text as it appears in the article"),
    url: str("Must be one of the ALLOWED LINKS"),
    why: str(),
  }), "Links placed in the body, all from ALLOWED LINKS", 6),
  cta: str("The closing call to action as written in the article"),
  source_notes: arr(obj({
    claim: str("A specific factual claim made about the business or its field"),
    source: str('Where it comes from: "profile", "brief", or "general knowledge"'),
  }), "For the editor: every specific claim and its basis", 30),
});

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "") || "article";
}

export type Finding = { code: string; severity: "error" | "warn" | "info"; message: string };

export type CheckContext = {
  minWords: number;
  maxWords: number;
  profile: BusinessProfile;
  allowedLinks: string[];
};

/**
 * Clean up what code can fix for certain (slug format, stray title line,
 * links to anywhere not allowed) and report what it can't.
 */
export function normalizeArticle(c: ArticleContent, allowedLinks: string[]): { content: ArticleContent; removedLinks: string[] } {
  let md = c.markdown.replace(/\r\n?/g, "\n").trim();
  // Writers sometimes repeat the title as a top heading; the title is shown separately.
  const first = md.split("\n")[0];
  if (/^#\s+/.test(first)) md = md.split("\n").slice(1).join("\n").trim();
  const { markdown, removed } = filterLinks(md, allowedLinks);
  const allowed = new Set(allowedLinks);
  return {
    content: {
      ...c,
      seo_title: c.seo_title.trim(),
      meta_description: c.meta_description.trim().replace(/\s+/g, " "),
      slug: slugify(c.slug || c.seo_title),
      excerpt: c.excerpt.trim(),
      markdown,
      tags: [...new Set(c.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 8),
      categories: [...new Set(c.categories.map((t) => t.trim()).filter(Boolean))].slice(0, 3),
      internal_links: c.internal_links.filter((l) => allowed.has(l.url) || markdown.includes(`](${l.url})`)),
    },
    removedLinks: removed,
  };
}

const PLACEHOLDER = /\[(insert|add|your|company|business name|city)[^\]]*\]|lorem ipsum|\bTODO\b|\{\{|\}\}|XX+/i;
const INTERNAL_NOTE = /\b(no|not|isn't|is not|wasn't|was not|un)[ -]?(been )?(confirmed|verified|documented)\b[^.\n]{0,60}|\b(according to|per|based on) (the|our|your) (profile|brief|source notes?)\b|\b(in|from) the (business )?profile\b|\bthe brief\b/i;
const RAW_HTML = /<\/?(script|iframe|div|span|style|img|object|embed|form|input|a)\b/i;

export function checkArticle(c: ArticleContent, ctx: CheckContext, removedLinks: string[] = []): Finding[] {
  const f: Finding[] = [];
  const text = c.markdown.toLowerCase();
  const words = wordCount(c.markdown);

  if (!c.seo_title) f.push({ code: "title_missing", severity: "error", message: "No SEO title." });
  else if (c.seo_title.length > 65) f.push({ code: "title_long", severity: "warn", message: `SEO title is ${c.seo_title.length} characters (aim for 60 or fewer).` });
  if (!c.meta_description) f.push({ code: "meta_missing", severity: "error", message: "No meta description." });
  else if (c.meta_description.length > 170) f.push({ code: "meta_long", severity: "warn", message: `Meta description is ${c.meta_description.length} characters (aim for 155 or fewer).` });
  else if (c.meta_description.length < 70) f.push({ code: "meta_short", severity: "warn", message: `Meta description is only ${c.meta_description.length} characters.` });
  if (!c.excerpt) f.push({ code: "excerpt_missing", severity: "error", message: "No excerpt." });
  if (!c.cta.trim()) f.push({ code: "cta_missing", severity: "error", message: "No call to action." });

  if (words < Math.round(ctx.minWords * 0.85)) f.push({ code: "too_short", severity: "error", message: `Only ${words} words (target ${ctx.minWords} to ${ctx.maxWords}).` });
  else if (words > Math.round(ctx.maxWords * 1.3)) f.push({ code: "too_long", severity: "warn", message: `${words} words (target ${ctx.minWords} to ${ctx.maxWords}).` });
  if (headings(c.markdown).length < 2) f.push({ code: "few_headings", severity: "warn", message: "Fewer than two section headings." });

  if (RAW_HTML.test(c.markdown)) f.push({ code: "raw_html", severity: "error", message: "Contains HTML tags; articles must be plain Markdown." });
  if (PLACEHOLDER.test(c.markdown)) f.push({ code: "placeholder", severity: "error", message: "Contains placeholder text." });
  const internal = c.markdown.match(INTERNAL_NOTE);
  if (internal) f.push({ code: "internal_note", severity: "error", message: `Talks to the editor instead of the reader: "${internal[0]}". Remove it or speak generally.` });
  if (/^\s*\|.*\|\s*$/m.test(c.markdown)) f.push({ code: "table", severity: "error", message: "Contains a table, which won't display. Use a list instead." });

  for (const claim of ctx.profile.prohibited_claims) {
    const k = claim.toLowerCase().replace(/^(never|don't|do not)\s+(say|claim|promise)\s+/i, "").replace(/['"]/g, "").trim();
    if (k.length >= 4 && k.length <= 80 && text.includes(k)) {
      f.push({ code: "prohibited_claim", severity: "error", message: `Makes a prohibited claim: "${claim}".` });
    }
  }
  for (const term of ctx.profile.voice.avoid_terms) {
    const t = term.toLowerCase().trim();
    if (t.length >= 3 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      f.push({ code: "avoid_term", severity: "error", message: `Uses a term the customer avoids: "${term}".` });
    }
  }
  for (const topic of ctx.profile.topics_to_avoid) {
    const t = topic.toLowerCase().trim();
    if (t.length >= 5 && (c.seo_title.toLowerCase().includes(t) || headings(c.markdown).some((h) => h.toLowerCase().includes(t)))) {
      f.push({ code: "avoided_topic", severity: "error", message: `Covers a topic the customer wants to avoid: "${topic}".` });
    }
  }

  const stats = c.markdown.match(/\b\d{1,3}(\.\d+)?\s?%|\b\d{1,3}(,\d{3})+\b|\bstud(y|ies) (show|found)\b/gi) ?? [];
  if (stats.length) f.push({ code: "statistics", severity: "warn", message: `Contains figures to verify: ${[...new Set(stats)].slice(0, 5).join(", ")}.` });
  if (/["“][^"”\n]{20,}["”]\s*(,)?\s*(said|says|according to)/i.test(c.markdown)) {
    f.push({ code: "quote", severity: "warn", message: "Contains a quotation. Make sure it's real and approved." });
  }
  if (removedLinks.length) {
    f.push({ code: "links_removed", severity: "info", message: `Removed ${removedLinks.length} link(s) to pages not on the allowed list: ${removedLinks.slice(0, 3).join(", ")}.` });
  }
  const destination = ctx.profile.cta.destination.toLowerCase();
  const closing = text.slice(Math.floor(text.length * 0.6));
  if (destination && !closing.includes(destination.replace(/^https?:\/\//, "").slice(0, 25)) && !closing.includes(c.cta.toLowerCase().slice(0, 20))) {
    f.push({ code: "cta_placement", severity: "warn", message: "The call to action doesn't appear near the end." });
  }
  return f;
}
