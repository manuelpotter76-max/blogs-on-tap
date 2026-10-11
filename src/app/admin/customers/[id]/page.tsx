import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getCustomer, recordAdminView } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { actionLabel, fmtDate, fmtDateTime, fmtMoney, ledgerLabel, statusLabel } from "@/lib/admin/format";
import { adjustCreditsAction } from "../../actions";
import { Topbar } from "../../topbar";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADJUST_MESSAGES: Record<string, { kind: "ok" | "err"; text: string }> = {
  ok: { kind: "ok", text: "Credits updated and recorded in the history." },
  bad_input: { kind: "err", text: "Use a whole number between -20 and 20 (not 0), and a reason of at least 5 characters." },
  would_go_negative: { kind: "err", text: "That would leave fewer than 0 articles for this month." },
  not_found: { kind: "err", text: "That billing period doesn't belong to this customer." },
};

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ adjust?: string }>;
}) {
  const adminId = await requireAdmin();
  const { id } = await params;
  const { adjust } = await searchParams;
  if (!UUID.test(id)) notFound();

  const db = await getDb();
  const customer = await getCustomer(db, id);
  if (!customer) notFound();
  await recordAdminView(db, adminId, id);

  const sub = customer.subscriptions[0];
  const openCycle = customer.cycles.find((c) => c.status === "open");
  const message = adjust ? ADJUST_MESSAGES[adjust] : undefined;

  return (
    <>
      <Topbar />
      <main className="wrap">
        <p style={{ margin: "0 0 8px" }}><a href="/admin">← All customers</a></p>
        <h1>{customer.org.name}</h1>
        <p className="sub">
          {customer.people.map((p) => p.email).join(", ") || "No contact email"} · Customer since {fmtDate(customer.org.created_at)}
        </p>

        {message ? <p className={`notice ${message.kind}`}>{message.text}</p> : null}

        <div className="stats">
          <div className="stat"><div className="label">Plan</div><div className="value">{sub ? sub.plan : "-"}</div></div>
          <div className="stat">
            <div className="label">Status</div>
            <div className="value" style={{ fontSize: 16, marginTop: 6 }}>
              <span className={`pill ${sub?.status ?? ""}`}>{statusLabel(sub?.status)}</span>
            </div>
          </div>
          <div className="stat"><div className="label">Articles left this month</div><div className="value">{openCycle ? openCycle.available : "-"}</div></div>
          <div className="stat"><div className="label">Current period</div><div className="value" style={{ fontSize: 15, marginTop: 6 }}>{sub ? `${fmtDate(sub.current_period_start)} to ${fmtDate(sub.current_period_end)}` : "-"}</div></div>
        </div>

        {sub ? (
          <>
            <h2>Subscription</h2>
            <div className="panel">
              <table>
                <tbody>
                  <tr><th>Plan</th><td>{sub.plan}: {fmtMoney(sub.price_cents)} a month, {sub.articles_per_cycle} articles</td></tr>
                  <tr><th>Status</th><td>{statusLabel(sub.status)}{sub.grace_until ? ` (grace period until ${fmtDate(sub.grace_until)})` : ""}</td></tr>
                  <tr><th>Zoho subscription ID</th><td>{sub.zoho_subscription_id}</td></tr>
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        <h2>Adjust credits</h2>
        <div className="panel">
          {openCycle ? (
            <form action={adjustCreditsAction} className="inline">
              <input type="hidden" name="orgId" value={customer.org.id} />
              <input type="hidden" name="cycleId" value={openCycle.cycle_id} />
              <div>
                <label htmlFor="delta">Add (+) or remove (-)</label>
                <input id="delta" name="delta" type="number" min={-20} max={20} step={1} required style={{ width: 120 }} />
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label htmlFor="reason">Reason (saved in the history)</label>
                <input id="reason" name="reason" required minLength={5} placeholder="e.g. Goodwill credit for a late article" style={{ width: "100%" }} />
              </div>
              <button type="submit">Save</button>
            </form>
          ) : (
            <p className="empty">There's no open billing period right now, so there's nothing to adjust.</p>
          )}
        </div>

        <h2>Credit history</h2>
        <div className="panel">
          {customer.ledger.length === 0 ? (
            <p className="empty">No credit activity yet.</p>
          ) : (
            <table>
              <thead><tr><th>When</th><th>What happened</th><th>Change</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>
                {customer.ledger.map((l, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(l.created_at)}</td>
                    <td>{ledgerLabel(l.kind)}</td>
                    <td className="num">{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                    <td className="wrap-text">{l.reason ?? ""}</td>
                    <td>{l.actor.startsWith("admin:") ? "You" : "System"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <h2>Activity</h2>
        <div className="panel">
          {customer.activity.length === 0 ? (
            <p className="empty">No activity yet.</p>
          ) : (
            <table>
              <thead><tr><th>When</th><th>What happened</th><th>By</th></tr></thead>
              <tbody>
                {customer.activity.map((a, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(a.created_at)}</td>
                    <td>{actionLabel(a.action)}</td>
                    <td>{a.actor.startsWith("admin:") ? "You" : a.actor === "system" ? "System" : a.actor}</td>
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
