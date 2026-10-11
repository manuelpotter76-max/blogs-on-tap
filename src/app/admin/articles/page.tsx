import { getDb } from "@/lib/db/client";
import { requireAdmin } from "@/lib/admin/session";
import { AUTO_APPROVED, listArticleCustomers, listArticleJobs, type ArticleJobRow } from "@/lib/admin/articles";
import { fmtDateTime, STATE_LABEL } from "@/lib/admin/format";
import { Topbar } from "../topbar";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUPS: { title: string; hint: string; states: string[] }[] = [
  { title: "Needs you", hint: "Review these before they go to the customer.", states: ["admin_review", "failed"] },
  { title: "In progress", hint: "The AI is working on these.", states: ["queued", "drafting", "quality_review", "needs_revision", "customer_revision_requested", "ready_for_customer"] },
  { title: "With customers", hint: "Delivered, waiting on the customer.", states: ["delivered"] },
  { title: "Done", hint: "", states: ["customer_approved"] },
];

/** Status filter options, in the order an article moves through them. */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  ...["admin_review", "failed", "queued", "drafting", "quality_review", "needs_revision",
      "customer_revision_requested", "ready_for_customer", "delivered", "customer_approved"]
    .map((s) => ({ value: s, label: STATE_LABEL[s] ?? s })),
  { value: AUTO_APPROVED, label: "Auto-approved" },
];

type Sort = "updated" | "cost";
type Dir = "asc" | "desc";
type View = { customer?: string; status?: string; sort: Sort; dir: Dir };

function statusLabel(r: ArticleJobRow): string {
  if (r.state === "customer_approved" && r.auto_approved) return "Auto-approved";
  return STATE_LABEL[r.state] ?? r.state;
}

function sortRows(rows: ArticleJobRow[], sort: Sort, dir: Dir): ArticleJobRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort === "cost") {
      // Articles with no AI cost yet always sit at the bottom.
      if (a.cost_usd == null || b.cost_usd == null) return (a.cost_usd == null ? 1 : 0) - (b.cost_usd == null ? 1 : 0);
      return sign * (Number(a.cost_usd) - Number(b.cost_usd));
    }
    return sign * (Date.parse(a.updated_at) - Date.parse(b.updated_at));
  });
}

function href(v: View): string {
  const q = new URLSearchParams();
  if (v.customer) q.set("customer", v.customer);
  if (v.status) q.set("status", v.status);
  if (v.sort !== "updated") q.set("sort", v.sort);
  if (v.dir !== "desc") q.set("dir", v.dir);
  const s = q.toString();
  return `/admin/articles${s ? `?${s}` : ""}`;
}

function SortHeader({ label, col, view }: { label: string; col: Sort; view: View }) {
  const active = view.sort === col;
  // First click sorts high-to-low / newest first; clicking again flips it.
  const next: Dir = active && view.dir === "desc" ? "asc" : "desc";
  const arrow = active ? (view.dir === "desc" ? " ↓" : " ↑") : "";
  return (
    <th aria-sort={active ? (view.dir === "desc" ? "descending" : "ascending") : "none"}>
      <a href={href({ ...view, sort: col, dir: next })} style={{ color: "inherit" }}
        title={`Sort by ${label.toLowerCase()}`}>{label}{arrow}</a>
    </th>
  );
}

function Table({ rows, view }: { rows: ArticleJobRow[]; view: View }) {
  return (
    <table>
      <thead><tr>
        <th>Article</th><th>Customer</th><th>Status</th><th>Version</th>
        <SortHeader label="AI cost" col="cost" view={view} />
        <SortHeader label="Updated" col="updated" view={view} />
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.job_id}>
            <td className="wrap-text"><a href={`/admin/articles/${r.job_id}`}>{r.title ?? r.topic ?? "Untitled"}</a></td>
            <td><a href={href({ ...view, customer: r.org_id })} style={{ color: "inherit" }} title="Show only this customer">{r.customer}</a></td>
            <td>
              <span className={`pill ${r.state === "failed" ? "cancelled" : r.state === "admin_review" ? "past_due" : r.state === "customer_approved" ? "active" : ""}`}>
                {statusLabel(r)}
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

export default async function ArticlesPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; status?: string; sort?: string; dir?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const view: View = {
    customer: sp.customer && UUID.test(sp.customer) ? sp.customer : undefined,
    status: sp.status && STATUS_OPTIONS.some((o) => o.value === sp.status) ? sp.status : undefined,
    sort: sp.sort === "cost" ? "cost" : "updated",
    dir: sp.dir === "asc" ? "asc" : "desc",
  };
  const db = await getDb();
  const [rows, customers] = await Promise.all([
    listArticleJobs(db, { customer: view.customer, status: view.status }),
    listArticleCustomers(db),
  ]);
  const filtered = Boolean(view.customer || view.status);
  const total = filtered ? rows.length : null;
  const totalCost = rows.reduce((s, r) => s + (r.cost_usd ? Number(r.cost_usd) : 0), 0);

  return (
    <>
      <Topbar />
      <main className="wrap">
        <h1>Articles</h1>
        <p className="sub">Nothing reaches a customer until you approve it here.</p>

        <div className="panel" style={{ marginBottom: 8 }}>
          <form method="get" action="/admin/articles" className="inline">
            <div>
              <label htmlFor="customer">Customer</label>
              <select id="customer" name="customer" defaultValue={view.customer ?? ""}>
                <option value="">All customers</option>
                {customers.map((c) => <option key={c.org_id} value={c.org_id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={view.status ?? ""}>
                <option value="">Any status</option>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {view.sort !== "updated" && <input type="hidden" name="sort" value={view.sort} />}
            {view.dir !== "desc" && <input type="hidden" name="dir" value={view.dir} />}
            <button type="submit">Filter</button>
            {filtered && <a href={href({ sort: view.sort, dir: view.dir })} style={{ alignSelf: "center" }}>Clear</a>}
          </form>
        </div>
        {filtered && (
          <p className="help">Showing {total} article{total === 1 ? "" : "s"}, ${totalCost.toFixed(2)} in AI cost.</p>
        )}

        {GROUPS.map((g) => {
          const list = sortRows(rows.filter((r) => g.states.includes(r.state)), view.sort, view.dir);
          if (filtered && list.length === 0) return null;
          return (
            <section key={g.title}>
              <h2>{g.title} <span className="muted" style={{ fontWeight: 400 }}>({list.length})</span></h2>
              {g.hint && <p className="help" style={{ margin: "-4px 0 8px" }}>{g.hint}</p>}
              <div className="panel">{list.length ? <Table rows={list} view={view} /> : <p className="empty">Nothing here.</p>}</div>
            </section>
          );
        })}
        {filtered && rows.length === 0 && <p className="empty">No articles match. <a href={href({ sort: view.sort, dir: view.dir })}>Clear the filters</a></p>}
      </main>
    </>
  );
}
