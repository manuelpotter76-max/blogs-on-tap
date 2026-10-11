import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadTopicsForReview } from "@/lib/review/topics";
import { CustomerShell, Notice } from "@/app/customer-shell";
import { decideTopicsAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pick your topics | Blogs on Tap" };

const INTENT: Record<string, string> = {
  informational: "Answers a question",
  commercial: "Helps someone compare options",
  transactional: "For someone ready to buy",
  local: "For people searching nearby",
};

export default async function TopicReviewPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; more?: string; error?: string }>;
}) {
  const { token } = await params;
  const { done, more, error } = await searchParams;
  const db = await getDb();
  const link = await resolveLink(db, token, "topic_review");
  const data = link?.subject_id ? await loadTopicsForReview(db, link.org_id, link.subject_id) : null;
  if (!link || !data) {
    return (
      <CustomerShell>
        <Notice title="This link isn't working">It may have expired. Reply to our email and we&apos;ll send a fresh one.</Notice>
      </CustomerShell>
    );
  }

  if (done !== undefined || !data.open) {
    const n = Number(done ?? NaN);
    const approved = Number.isFinite(n) ? n : data.topics.filter((t) => t.status !== "proposed" && t.status !== "rejected").length;
    return (
      <CustomerShell>
        <Notice title={approved > 0 ? "Thanks, you're all set" : "Got it, we'll try again"}>
          {approved > 0
            ? `You approved ${approved} topic${approved === 1 ? "" : "s"}. We'll start writing, and every article gets a careful review before it reaches you.`
            : "None of these were right, and that's useful to know. We'll send a fresh batch shaped by your notes."}
          {approved > 0 && more ? " We'll also send a few more ideas soon so there's always something lined up." : ""}
        </Notice>
      </CustomerShell>
    );
  }

  const proposed = data.topics.filter((t) => t.status === "proposed");
  const action = decideTopicsAction.bind(null, token);

  return (
    <CustomerShell>
      <form action={action}>
        <section className="card">
          <h1>Pick your blog topics</h1>
          <p className="sub">{data.summary}</p>
          <p className="help">Everything is ticked to start. Untick any you&apos;d rather skip, and tell us why if you like.
            That helps the next batch.</p>
          {error === "undecided" && <p className="flash err" role="alert">Something changed while you were choosing. Please try again.</p>}
        </section>
        <section className="card">
          {proposed.map((t) => (
            <div className="topic" key={t.id}>
              <input type="hidden" name="topic" value={t.id} />
              <label className="consent" style={{ border: 0, padding: 0, background: "none" }}>
                <input type="checkbox" name={`approve__${t.id}`} defaultChecked />
                <strong style={{ fontSize: 16 }}>{t.title}</strong>
              </label>
              <p className="meta">{INTENT[t.search_intent] ?? t.search_intent} · for {t.audience}</p>
              <p style={{ margin: "6px 0" }}>{t.angle}</p>
              {t.subtopics.length > 0 && <ul>{t.subtopics.map((s, i) => <li key={i}>{s}</li>)}</ul>}
              <details>
                <summary className="meta">Add a note</summary>
                <textarea name={`note__${t.id}`} rows={2} maxLength={1000} placeholder="e.g. we don't do this anymore, or focus on X instead" />
              </details>
            </div>
          ))}
          <div className="nav"><span /><button type="submit">Save my choices</button></div>
        </section>
      </form>
    </CustomerShell>
  );
}
