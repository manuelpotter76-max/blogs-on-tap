import { getDb } from "@/lib/db/client";
import { listCustomers } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { fmtDate, fmtDay, statusLabel } from "@/lib/admin/format";
import { Topbar } from "./topbar";
import { testEmailAction } from "./actions";
import { getWeek, type WeekItem } from "@/lib/admin/week";

export const dynamic = "force-dynamic";

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  await requireAdmin();
  const { email } = await searchParams;
  const db = await getDb();
  const customers = await listCustomers(db);
  const week = await getWeek(db);

  const active = customers.filter((c) => c.status === "active" || c.status === "cancel_scheduled").length;
  const attention = customers.filter((c) => c.status === "past_due" || c.status === "suspended").length;
  const creditsOpen = customers.reduce((sum, c) => sum + (c.credits_left ?? 0), 0);

  return (
    <>
      <Topbar />
      <main className="wrap">
        {email && <p className={`notice ${email.startsWith("Sent") ? "ok" : "err"}`}>{email}</p>}
        <h1>This week</h1>
        <p className="sub">What needs you, what customers are working on, and what's coming in the next 7 days.</p>
        <div className="week">
          <WeekList title="Needs you" items={week.needsYou} empty="Nothing. You're all caught up." urgent />
          <WeekList title="Waiting on customers" items={week.waiting} empty="No one is mid-step right now." />
          <WeekList title="Coming up" items={week.comingUp} empty="No renewals or deadlines in the next 7 days." />
        </div>

        <h2 style={{ marginTop: 36 }}>Customers</h2>
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

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const future = ms < 0;
  const days = Math.floor(Math.abs(ms) / 86_400_000);
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  const span = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : "under an hour";
  return future ? `in ${span}` : `${span} ago`;
}

function WeekList({ title, items, empty, urgent }: { title: string; items: WeekItem[]; empty: string; urgent?: boolean }) {
  return (
    <section className={`week-col ${urgent && items.length ? "urgent" : ""}`}>
      <h3>{title} <span className="muted">({items.length})</span></h3>
      {items.length === 0 ? <p className="muted" style={{ margin: 0 }}>{empty}</p> : (
        <ul>
          {items.map((i, n) => (
            <li key={n}>
              <a href={i.href}>{i.what}</a>
              <div className="muted">{i.customer}{i.when ? ` · ${ago(i.when)}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
