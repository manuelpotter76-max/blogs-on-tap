import { getDb } from "@/lib/db/client";
import { listCustomers } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { fmtDate, fmtDay, statusLabel } from "@/lib/admin/format";
import { Topbar } from "./topbar";
import { testEmailAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  await requireAdmin();
  const { email } = await searchParams;
  const db = await getDb();
  const customers = await listCustomers(db);
  const { rows: waiting } = await db.query<{ n: number }>(
    `select count(*)::int as n from app.production_jobs where state in ('admin_review', 'failed')`);

  const active = customers.filter((c) => c.status === "active" || c.status === "cancel_scheduled").length;
  const attention = customers.filter((c) => c.status === "past_due" || c.status === "suspended").length;
  const creditsOpen = customers.reduce((sum, c) => sum + (c.credits_left ?? 0), 0);

  return (
    <>
      <Topbar />
      <main className="wrap">
        <h1>Customers</h1>
        <p className="sub">Everyone who has subscribed, newest first.</p>
        {email && <p className={`notice ${email.startsWith("Sent") ? "ok" : "err"}`}>{email}</p>}
        {waiting[0].n > 0 && (
          <p className="notice ok"><a href="/admin/articles">{waiting[0].n} article{waiting[0].n === 1 ? "" : "s"} waiting for your review →</a></p>
        )}

        <div className="stats" style={{ marginBottom: 20 }}>
          <div className="stat"><div className="label">Active</div><div className="value">{active}</div></div>
          <div className="stat"><div className="label">Need attention</div><div className="value">{attention}</div></div>
          <div className="stat"><div className="label">Articles owed this month</div><div className="value">{creditsOpen}</div></div>
          <div className="stat"><div className="label">All customers</div><div className="value">{customers.length}</div></div>
        </div>

        <div className="panel">
          {customers.length === 0 ? (
            <p className="empty">No customers yet. They appear here automatically when someone subscribes in Zoho.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Articles left</th>
                  <th>Period ends</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.org_id}>
                    <td><a href={`/admin/customers/${c.org_id}`}>{c.name}</a></td>
                    <td>{c.email ?? "-"}</td>
                    <td>{c.plan ?? "-"}</td>
                    <td><span className={`pill ${c.status ?? ""}`}>{statusLabel(c.status)}</span></td>
                    <td className="num">{c.credits_left ?? "-"}</td>
                    <td>{fmtDay(c.period_end)}</td>
                    <td>{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <form action={testEmailAction} style={{ marginTop: 24 }}>
          <button type="submit" className="ghost">Send test email to {process.env.ADMIN_EMAIL ?? "admin"}</button>
        </form>
      </main>
    </>
  );
}
