import { getDb } from "@/lib/db/client";
import { listCustomers } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { fmtDate, statusLabel } from "@/lib/admin/format";
import { Topbar } from "./topbar";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  const customers = await listCustomers(await getDb());

  const active = customers.filter((c) => c.status === "active" || c.status === "cancel_scheduled").length;
  const attention = customers.filter((c) => c.status === "past_due" || c.status === "suspended").length;
  const creditsOpen = customers.reduce((sum, c) => sum + (c.credits_left ?? 0), 0);

  return (
    <>
      <Topbar />
      <main className="wrap">
        <h1>Customers</h1>
        <p className="sub">Everyone who has subscribed, newest first.</p>

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
                    <td>{fmtDate(c.period_end)}</td>
                    <td>{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
