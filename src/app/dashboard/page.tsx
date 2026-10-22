import { getDb } from "@/lib/db/client";
import { getHome } from "@/lib/customer/home";
import { requireCustomer } from "@/lib/customer/session";
import { DashboardShell } from "./shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard | Blogs on Tap" };

const day = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "-";

const STATE: Record<string, string> = { delivered: "Ready to read", approved: "Approved", revising: "Being revised" };

export default async function DashboardHome({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const s = await requireCustomer("/dashboard");
  const { welcome } = await searchParams;
  const home = await getHome(await getDb(), s.orgId);
  const first = s.fullName?.trim() && s.fullName.trim() !== s.orgName ? s.fullName.trim().split(/\s+/)[0] : null;

  return (
    <DashboardShell s={s} active="home">
      {welcome && <p className="flash ok" role="status">You're all set. Next time, sign in at app.blogsontap.com with your email and password.</p>}
      <h1 style={{ margin: "0 0 16px" }}>{first ? `Hi ${first}` : "Welcome back"}</h1>

      <section className="card">
        <h2>Needs you</h2>
        {home.needsYou.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>You're all caught up. We'll email you when something new is ready.</p>
        ) : home.needsYou.map((n, i) => (
          <div className="todo" key={i}>
            <div className="what"><strong>{n.label}</strong><span>{n.detail}</span></div>
            <a className="go" href={n.href}>Open</a>
          </div>
        ))}
      </section>

      {home.plan && (
        <section className="card">
          <h2>This month</h2>
          <div className="mini-stats">
            <div><div className="label">Plan</div><div className="value">{home.plan.name}</div></div>
            <div><div className="label">Ready for you</div><div className="value">{home.month?.ready ?? 0}</div></div>
            <div><div className="label">Being written</div><div className="value">{home.month?.inWorks ?? 0}</div></div>
            <div><div className="label">Renews</div><div className="value">{day(home.plan.renewsOn)}</div></div>
          </div>
          <p className="help" style={{ margin: "12px 0 0" }}>
            {home.plan.perMonth} articles a month.{home.month && home.month.notStarted > 0
              ? ` ${home.month.notStarted} more ${home.month.notStarted === 1 ? "starts" : "start"} as soon as there are approved topics.` : ""}
          </p>
        </section>
      )}

      <section className="card">
        <h2>Recent articles</h2>
        {home.recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Your first articles will show up here.</p>
        ) : home.recent.map((r, i) => (
          <div className="list-row" key={i}>
            <div><a href={r.href}>{r.title}</a> <span className="muted" style={{ fontSize: 13 }}>· {STATE[r.state]}</span></div>
            <span className="when">{day(r.deliveredAt)}</span>
          </div>
        ))}
      </section>
    </DashboardShell>
  );
}
