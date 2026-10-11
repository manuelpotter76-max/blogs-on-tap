import { getDb } from "@/lib/db/client";
import { requireAdmin } from "@/lib/admin/session";
import { listArticleJobs, type ArticleJobRow } from "@/lib/admin/articles";
import { fmtDateTime, STATE_LABEL } from "@/lib/admin/format";
import { Topbar } from "../topbar";

export const dynamic = "force-dynamic";

const GROUPS: { title: string; hint: string; states: string[] }[] = [
  { title: "Needs you", hint: "Review these before they go to the customer.", states: ["admin_review", "failed"] },
  { title: "In progress", hint: "The AI is working on these.", states: ["queued", "drafting", "quality_review", "needs_revision", "customer_revision_requested", "ready_for_customer"] },
  { title: "With customers", hint: "Delivered, waiting on the customer.", states: ["delivered"] },
  { title: "Done", hint: "", states: ["customer_approved"] },
];

function Table({ rows }: { rows: ArticleJobRow[] }) {
  return (
    <table>
      <thead><tr><th>Article</th><th>Customer</th><th>Status</th><th>Version</th><th>AI cost</th><th>Updated</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.job_id}>
            <td className="wrap-text"><a href={`/admin/articles/${r.job_id}`}>{r.title ?? r.topic ?? "Untitled"}</a></td>
            <td>{r.customer}</td>
            <td>
              <span className={`pill ${r.state === "failed" ? "cancelled" : r.state === "admin_review" ? "past_due" : r.state === "customer_approved" ? "active" : ""}`}>
                {STATE_LABEL[r.state] ?? r.state}
              </span>
              {r.flagged && <span className="pill cancelled" style={{ marginLeft: 6 }}>flagged</span>}
            </td>
            <td className="num">{r.version ?? "-"}</td>
            <td className="num">{r.cost_usd ? `$${Number(r.cost_usd).toFixed(3)}` : "-"}</td>
            <td>{fmtDateTime(r.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function ArticlesPage() {
  await requireAdmin();
  const rows = await listArticleJobs(await getDb());
  return (
    <>
      <Topbar />
      <main className="wrap">
        <h1>Articles</h1>
        <p className="sub">Nothing reaches a customer until you approve it here.</p>
        {GROUPS.map((g) => {
          const list = rows.filter((r) => g.states.includes(r.state));
          return (
            <section key={g.title}>
              <h2>{g.title} <span className="muted" style={{ fontWeight: 400 }}>({list.length})</span></h2>
              {g.hint && <p className="help" style={{ margin: "-4px 0 8px" }}>{g.hint}</p>}
              <div className="panel">{list.length ? <Table rows={list} /> : <p className="empty">Nothing here.</p>}</div>
            </section>
          );
        })}
      </main>
    </>
  );
}
