import type { ArticleContent } from "./content";
import { escapeHtml, renderMarkdown } from "./markdown";

/** What the customer copies or downloads: the article body, ready to paste into a blog editor. */
export function exportHtml(c: ArticleContent): string {
  return `<h1>${escapeHtml(c.seo_title)}</h1>\n${renderMarkdown(c.markdown)}\n`;
}

export function exportMarkdown(c: ArticleContent): string {
  const front = [
    "---",
    `title: ${JSON.stringify(c.seo_title)}`,
    `description: ${JSON.stringify(c.meta_description)}`,
    `slug: ${c.slug}`,
    `excerpt: ${JSON.stringify(c.excerpt)}`,
    `tags: [${c.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `categories: [${c.categories.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
  ].join("\n");
  return `${front}\n\n# ${c.seo_title}\n\n${c.markdown}\n`;
}
