import type { Db } from "@/lib/db/client";
import { enqueue, type Task } from "@/lib/tasks/queue";
import { crawlSite, type CrawledPage } from "@/lib/web/fetch-site";
import type { Answers } from "./questions";

type Crawl = typeof crawlSite;

/**
 * Read the customer's site (with consent), store the page text, then hand off
 * to research. A site that can't be read is not a failure: research runs on
 * the answers alone and the admin page shows what was skipped.
 */
export async function runWebsiteFetch(db: Db, task: Task, crawl: Crawl = crawlSite): Promise<void> {
  const orgId = task.org_id;
  const ob = (await db.query<{ answers: Answers; website_consent: boolean }>(
    `select answers, website_consent from app.onboarding_responses where org_id = $1 and submitted_at is not null`,
    [orgId])).rows[0];

  const starts = ob?.website_consent
    ? [ob.answers.website, ob.answers.blog_url].map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];

  let pages: CrawledPage[] = [];
  let skipped: { url: string; reason: string }[] = [];
  if (starts.length) ({ pages, skipped } = await crawl(starts));

  await db.transaction(async (tx) => {
    for (const p of pages) {
      const text = [p.title && `Title: ${p.title}`, p.description && `Description: ${p.description}`, p.text]
        .filter(Boolean).join("\n");
      await tx.query(
        `insert into app.source_documents (org_id, kind, source_url, extracted_text, size_bytes, status)
         values ($1, 'website_page', $2, $3, $4, 'stored')
         on conflict (org_id, source_url) where kind = 'website_page'
         do update set extracted_text = excluded.extracted_text, size_bytes = excluded.size_bytes, status = 'stored'`,
        [orgId, p.url, text, text.length]);
    }
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', 'website.fetched', $2, $3)`,
      [orgId, starts[0] ?? "", JSON.stringify({ pages: pages.length, skipped: skipped.slice(0, 20) })]);
    await enqueue(tx, orgId, "business_research", `business_research:${orgId}:1`);
  });
}
