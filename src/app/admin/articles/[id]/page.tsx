import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { requireAdmin } from "@/lib/admin/session";
import { getArticleJob } from "@/lib/admin/articles";
import { fmtDateTime, STATE_LABEL } from "@/lib/admin/format";
import { escapeHtml, renderMarkdown } from "@/lib/articles/markdown";
import { articleAction } from "../../actions";
import { Topbar } from "../../topbar";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DONE: Record<string, string> = {
  approve: "Approved. The customer gets it within a minute.",
  edit: "Saved as a new version.",
  revise: "Sent back to the writer. Check back in a few minutes.",
  give_up: "Stopped. The credit is back on the customer's balance.",
  retry: "Retrying from where it stopped.",
};
const RESULT: Record<string, string> = {
  wrong_state: "That isn't possible at this stage (it may have changed while you were looking).",
  invalid: "Something's missing. A note needs at least a few words; edits need a title and body.",
  not_found: "Couldn't find that article.",
};

function Act({ jobId, action, label, kind = "" }: { jobId: string; action: string; label: string; kind?: string }) {
  return (
    <form action={articleAction} style={{ display: "inline" }}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={kind}>{label}</button>
    </form>
  );
}

const by = (s: string) => (s === "ai" ? "AI draft" : s === "ai_revision" ? "AI revision" : s.startsWith("admin:") ? "Your edit" : s);

export default async function ArticleReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string; result?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { done, result } = await searchParams;
  if (!UUID.test(id)) notFound();
  const d = await getArticleJob(await getDb(), id);
  if (!d) notFound();

  const c = d.current?.content;
  const review = d.report?.ai_review;
  const inReview = d.job.state === "admin_review";
  const flash = done ? (result === "ok" ? { kind: "ok", text: DONE[done] } : { kind: "err", text: RESULT[result ?? ""] ?? "Something went wrong." }) : null;
  const errors = d.report?.code_findings.filter((f) => f.severity === "error") ?? [];

  return (
    <>
      <Topbar />
      <main className="wrap">
        <p style={{ margin: "0 0 8px" }}><a href="/admin/articles">← All articles</a> · <a href={`/admin/customers/${d.job.org_id}`}>{d.customer.name}</a></p>
        <h1>{c?.seo_title ?? d.topic?.title ?? "Article"}</h1>
        <p className="sub">
          <span className={`pill ${d.job.state === "failed" ? "cancelled" : inReview ? "past_due" : ""}`}>{STATE_LABEL[d.job.state] ?? d.job.state}</span>
          {d.job.flagged && <span className="pill cancelled" style={{ marginLeft: 6 }}>flagged: read carefully</span>}
          {" "}· {d.current ? `version ${d.current.version}, ${d.current.word_count} words` : "no draft yet"} · AI cost ${d.costUsd.toFixed(3)}
        </p>
        {flash?.text && <p className={`notice ${flash.kind}`}>{flash.text}</p>}
        {d.job.last_error && <p className="notice err">Last error: {d.job.last_error}</p>}

        <div className="panel" style={{ padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {inReview && <Act jobId={d.job.id} action="approve" label={d.article?.delivered_version ? "Approve and send the update" : "Approve and send to customer"} />}
          {d.job.state === "failed" && <Act jobId={d.job.id} action="retry" label="Retry" />}
          {["admin_review", "failed", "queued", "drafting", "quality_review", "needs_revision"].includes(d.job.state) && !d.article?.delivered_version && (
            <form action={articleAction} style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="hidden" name="jobId" value={d.job.id} />
              <input type="hidden" name="action" value="give_up" />
              <label style={{ margin: 0, display: "inline-flex", gap: 4, alignItems: "center" }}><input type="checkbox" name="retire" /> retire topic</label>
              <button type="submit" className="ghost">Give up and return credit</button>
            </form>
          )}
          {d.customerLink && <span className="help" style={{ margin: 0 }}>Customer link: <input readOnly value={d.customerLink} style={{ width: 360 }} /></span>}
        </div>

        {d.report && (
          <>
            <h2>Quality check {d.report.passed ? "passed" : "did not pass"}{d.report.high_risk ? " · high risk" : ""}</h2>
            <div className="panel" style={{ padding: "4px 14px" }}>
              {review && <p className="wrap-text">{review.summary}</p>}
              {review && (
                <p className="help">Scores (1 to 5): {Object.entries(review.scores).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
              )}
              {review?.high_risk_reason && <p className="notice err">High risk: {review.high_risk_reason}</p>}
              <ul>
                {errors.map((f, i) => <li key={`e${i}`}><strong>Must fix:</strong> {f.message}</li>)}
                {review?.unsupported_claims.map((u, i) => <li key={`u${i}`}><strong>Unsupported:</strong> &ldquo;{u.claim}&rdquo; ({u.why})</li>)}
                {review?.issues.map((i2, i) => <li key={`i${i}`}><strong>{i2.severity}</strong> ({i2.area}): {i2.problem} <em>Fix: {i2.fix}</em></li>)}
                {d.report.code_findings.filter((f) => f.severity !== "error").map((f, i) => <li key={`w${i}`} className="muted">{f.message}</li>)}
              </ul>
            </div>
          </>
        )}

        {c && (
          <>
            <h2>Article</h2>
            <div className="panel" style={{ padding: 20 }}>
              <p className="help">Meta description ({c.meta_description.length} characters): {c.meta_description}</p>
              <p className="help">Slug: /{c.slug} · Tags: {c.tags.join(", ") || "-"} · Categories: {c.categories.join(", ") || "-"}</p>
              <p className="help">Excerpt: {c.excerpt}</p>
              <article className="article-body" dangerouslySetInnerHTML={{ __html: `<h1>${escapeHtml(c.seo_title)}</h1>${renderMarkdown(c.markdown)}` }} />
              {c.source_notes.length > 0 && (
                <>
                  <h3>Claims and where they came from</h3>
                  <ul className="help">{c.source_notes.map((s, i) => <li key={i}>{s.claim} <em>({s.source})</em></li>)}</ul>
                </>
              )}
            </div>
          </>
        )}

        {inReview && c && (
          <>
            <h2>Send it back to the writer</h2>
            <div className="panel">
              <form action={articleAction} className="inline">
                <input type="hidden" name="jobId" value={d.job.id} />
                <input type="hidden" name="action" value="revise" />
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label htmlFor="note">What should change?</label>
                  <textarea id="note" name="note" rows={3} required minLength={5} style={{ width: "100%" }}
                    placeholder="e.g. Cut the second section, it repeats the intro. Mention the free inspection." />
                </div>
                <button type="submit">Send back</button>
              </form>
            </div>

            <h2>Edit it yourself</h2>
            <div className="panel">
              <form action={articleAction} style={{ padding: 14, display: "grid", gap: 10 }}>
                <input type="hidden" name="jobId" value={d.job.id} />
                <input type="hidden" name="action" value="edit" />
                <div><label htmlFor="seo_title">SEO title</label><input id="seo_title" name="seo_title" defaultValue={c.seo_title} style={{ width: "100%" }} /></div>
                <div><label htmlFor="meta_description">Meta description</label><input id="meta_description" name="meta_description" defaultValue={c.meta_description} style={{ width: "100%" }} /></div>
                <div><label htmlFor="slug">Slug</label><input id="slug" name="slug" defaultValue={c.slug} style={{ width: "100%" }} /></div>
                <div><label htmlFor="excerpt">Excerpt</label><input id="excerpt" name="excerpt" defaultValue={c.excerpt} style={{ width: "100%" }} /></div>
                <div><label htmlFor="cta">Call to action</label><input id="cta" name="cta" defaultValue={c.cta} style={{ width: "100%" }} /></div>
                <div><label htmlFor="markdown">Body (Markdown)</label>
                  <textarea id="markdown" name="markdown" rows={24} defaultValue={c.markdown} style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 13 }} /></div>
                <div><button type="submit">Save as new version</button></div>
              </form>
            </div>
          </>
        )}

        {d.revisions.length > 0 && (
          <>
            <h2>Change requests</h2>
            <div className="panel">
              <table>
                <thead><tr><th>When</th><th>From</th><th>Note</th><th>Status</th></tr></thead>
                <tbody>{d.revisions.map((r, i) => (
                  <tr key={i}><td>{fmtDateTime(r.created_at)}</td><td>{r.requested_by === "customer" ? "Customer" : "You"}</td>
                    <td className="wrap-text">{r.note}</td><td>{r.status}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}

        {d.versions.length > 0 && (
          <>
            <h2>Versions</h2>
            <div className="panel">
              <table>
                <thead><tr><th>Version</th><th>Made by</th><th>Words</th><th>When</th></tr></thead>
                <tbody>{d.versions.map((v) => (
                  <tr key={v.version}><td>{v.version}{v.version === d.article?.delivered_version ? " (customer has this)" : ""}</td>
                    <td>{by(v.created_by)}</td><td className="num">{v.word_count}</td><td>{fmtDateTime(v.created_at)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}

        {d.brief && (
          <>
            <h2>Brief</h2>
            <div className="panel" style={{ padding: "4px 14px" }}>
              <p><strong>Reader:</strong> {d.brief.reader}</p>
              <p><strong>Angle:</strong> {d.brief.angle}</p>
              <ol>{d.brief.outline.map((o, i) => <li key={i}>{o.heading}</li>)}</ol>
            </div>
          </>
        )}
      </main>
    </>
  );
}
