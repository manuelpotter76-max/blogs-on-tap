import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadForCustomer } from "@/lib/articles/review";
import { exportHtml, exportMarkdown } from "@/lib/articles/export";
import { escapeHtml, renderMarkdown } from "@/lib/articles/markdown";
import { CustomerShell, Notice } from "@/app/customer-shell";
import { articleDecisionAction } from "../actions";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your article | Blogs on Tap" };

const RESULT: Record<string, string> = {
  invalid: "Please tell us a little more about what to change.",
  limit: "This article has used its included revisions, or the revision window has closed. Reply to our email and we'll sort it out.",
  wrong_state: "This article has already been approved or is being revised.",
};

export default async function ArticlePage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ result?: string; d?: string }>;
}) {
  const { token } = await params;
  const { result, d } = await searchParams;
  const db = await getDb();
  const link = await resolveLink(db, token, "article_review");
  const view = link?.subject_id ? await loadForCustomer(db, link.org_id, link.subject_id) : null;
  if (!link || !view?.content) {
    return (
      <CustomerShell>
        <Notice title="This link isn't working">It may have expired. Reply to our email and we&apos;ll send a fresh one.</Notice>
      </CustomerShell>
    );
  }

  const c = view.content;
  const revising = view.jobState === "customer_revision_requested" || ["quality_review", "needs_revision", "admin_review", "ready_for_customer"].includes(view.jobState);
  const approved = view.jobState === "customer_approved";
  const action = articleDecisionAction.bind(null, token);
  const okText = result === "ok" ? (d === "approve" ? "Thanks! It's marked as approved." : "Got it. We're working on your changes and will email you when the new version is ready.") : null;
  const errText = result && result !== "ok" ? RESULT[result] ?? "Something went wrong. Please try again." : null;
  const dl = `/review/article/${encodeURIComponent(token)}/download`;

  return (
    <CustomerShell>
      {okText && <p className="flash ok" role="status">{okText}</p>}
      {errText && <p className="flash err" role="alert">{errText}</p>}
      {revising && !okText && (
        <p className="flash ok">We&apos;re working on the changes you asked for. This is the current version until the new one arrives.</p>
      )}

      <section className="card">
        <article className="article-body" dangerouslySetInnerHTML={{ __html: `<h1>${escapeHtml(c.seo_title)}</h1>${renderMarkdown(c.markdown)}` }} />
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Put it on your website</h2>
        <p className="help">Copy the article and paste it into your blog editor (WordPress, Wix, Squarespace and most others keep the headings and links). Or download a file.</p>
        <div className="article-actions">
          <CopyButton label="Copy article" text={exportMarkdown(c)} html={exportHtml(c)} />
          <CopyButton label="Copy HTML" text={exportHtml(c)} />
          <a className="button-link" href={`${dl}?format=html`}>Download HTML</a>
          <a className="button-link" href={`${dl}?format=md`}>Download Markdown</a>
        </div>
        <dl className="meta-list">
          <dt>SEO title</dt><dd>{c.seo_title} <CopyButton label="Copy" text={c.seo_title} /></dd>
          <dt>Meta description</dt><dd>{c.meta_description} <CopyButton label="Copy" text={c.meta_description} /></dd>
          <dt>URL slug</dt><dd>/{c.slug}</dd>
          <dt>Excerpt</dt><dd>{c.excerpt}</dd>
          {c.tags.length > 0 && <><dt>Tags</dt><dd>{c.tags.join(", ")}</dd></>}
          {c.categories.length > 0 && <><dt>Category</dt><dd>{c.categories.join(", ")}</dd></>}
          {c.internal_links.length > 0 && (
            <><dt>Links in this article</dt><dd>{c.internal_links.map((l) => `${l.anchor} → ${l.url}`).join("; ")}</dd></>
          )}
        </dl>
      </section>

      {!approved && !revising && view.jobState === "delivered" && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Happy with it?</h2>
          <form action={action} style={{ marginBottom: 18 }}>
            <input type="hidden" name="decision" value="approve" />
            <button type="submit">Yes, approve it</button>
          </form>
          {view.revisionsLeft > 0 && view.windowOpen ? (
            <form action={action}>
              <input type="hidden" name="decision" value="revise" />
              <div className="field">
                <label htmlFor="note">Or tell us what to change</label>
                <p className="help">Your plan includes {view.revisionsLeft} round{view.revisionsLeft === 1 ? "" : "s"} of changes
                  within {view.revisionDays} days of delivery. Be as specific as you can.</p>
                <textarea id="note" name="note" rows={4} required minLength={5} maxLength={3000}
                  placeholder="e.g. We don't offer financing, please remove that part. Mention our 24/7 line instead." />
              </div>
              <button type="submit" className="secondary">Request changes</button>
            </form>
          ) : (
            <p className="help">Need changes? Reply to our email and we&apos;ll take care of it.</p>
          )}
        </section>
      )}
      {approved && <p className="fine">You approved this article. Thanks!</p>}
    </CustomerShell>
  );
}
