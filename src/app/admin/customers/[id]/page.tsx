import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getCustomer, recordAdminView } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { actionLabel, fmtDate, fmtDateTime, fmtDay, fmtMoney, ledgerLabel, statusLabel } from "@/lib/admin/format";
import { adjustCreditsAction, customerDetailsAction, sendLoginSetupAction } from "../../actions";
import { Topbar } from "../../topbar";
import { getOnboardingOverview } from "@/lib/admin/onboarding";
import { OnboardingSection } from "./onboarding-section";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADJUST_MESSAGES: Record<string, { kind: "ok" | "err"; text: string }> = {
  ok: { kind: "ok", text: "Credits updated and recorded in the history." },
  bad_input: { kind: "err", text: "Use a whole number between -20 and 20 (not 0), and a reason of at least 5 characters." },
  would_go_negative: { kind: "err", text: "That would leave fewer than 0 articles for this month." },
  not_found: { kind: "err", text: "That billing period doesn't belong to this customer." },
};

const LOGIN_MESSAGES: Record<string, { kind: "ok" | "err"; text: string }> = {
  sent: { kind: "ok", text: "Login setup email sent. The link works once, for 7 days." },
  already_set: { kind: "err", text: "They already have a login. If they're stuck, they can use \"Forgot your password?\" on the sign-in page." },
  no_owner: { kind: "err", text: "This customer has no contact email to send it to. Add one under Name and email first." },
  email_failed: { kind: "err", text: "The email didn't go out: our email service (ZeptoMail) refused it. Check the sender and domain in ZeptoMail, then try again. The details are in the Emails list under Onboarding." },
};

const DETAILS_MESSAGES: Record<string, { kind: "ok" | "err"; text: string }> = {
  ok: { kind: "ok", text: "Saved. New emails go to the updated address, and new articles use the updated business name." },
  unchanged: { kind: "ok", text: "Nothing changed." },
  bad_input: { kind: "err", text: "Business name needs 2 to 120 characters, and the contact name can't be over 120." },
  bad_email: { kind: "err", text: "That email address doesn't look right." },
  email_taken: { kind: "err", text: "That email already belongs to a different customer." },
  not_found: { kind: "err", text: "Couldn't find this customer." },
};

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ adjust?: string; onb?: string; details?: string; login?: string }>;
}) {
  const adminId = await requireAdmin();
  const { id } = await params;
  const { adjust, onb, details, login } = await searchParams;
  if (!UUID.test(id)) notFound();

  const db = await getDb();
  const customer = await getCustomer(db, id);
  if (!customer) notFound();
  await recordAdminView(db, adminId, id);
  const onboarding = await getOnboardingOverview(db, id);

  const sub = customer.subscriptions[0];
  const openCycle = customer.cycles.find((c) => c.status === "open");
  const message = adjust ? ADJUST_MESSAGES[adjust] : undefined;
  const detailsMsg = details ? DETAILS_MESSAGES[details] : undefined;
  const owner = customer.people.find((p) => p.role === "owner") ?? customer.people[0];

  return (
    <>
      <Topbar />
      <main className="wrap">
        <p style={{ margin: "0 0 8px" }}><a href="/admin">← All customers</a></p>
        <h1>{customer.org.name}</h1>
        <p className="sub">
          {owner?.email ?? "No contact email"} · Customer since {fmtDate(customer.org.created_at)}
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
          <div className="stat"><div className="label">Current period</div><div className="value" style={{ fontSize: 15, marginTop: 6 }}>{sub ? `${fmtDay(sub.current_period_start)} to ${fmtDay(sub.current_period_end)}` : "-"}</div></div>
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

        <h2 id="details">Name and email</h2>
        {detailsMsg ? <p className={`notice ${detailsMsg.kind}`}>{detailsMsg.text}</p> : null}
        <div className="panel">
          <form action={customerDetailsAction} className="inline">
            <input type="hidden" name="orgId" value={customer.org.id} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="businessName">Business name</label>
              <input id="businessName" name="businessName" required minLength={2} maxLength={120}
                defaultValue={customer.org.name} style={{ width: "100%" }} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="contactName">Contact name</label>
              <input id="contactName" name="contactName" maxLength={120}
                defaultValue={owner?.full_name ?? ""} style={{ width: "100%" }} />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required maxLength={254}
                defaultValue={owner?.email ?? ""} style={{ width: "100%" }} />
            </div>
            <button type="submit">Save</button>
          </form>
          <p className="empty" style={{ marginTop: 10 }}>This changes the app only. If they want invoices at the new address too, update it in Zoho Billing.</p>
        </div>

        <h2 id="login">Dashboard logins</h2>
        {login && LOGIN_MESSAGES[login] ? <p className={`notice ${LOGIN_MESSAGES[login].kind}`}>{LOGIN_MESSAGES[login].text}</p> : null}
        <div className="panel">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th>Login</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {customer.people.map((p) => (
                <tr key={p.user_id}>
                  <td>{p.email}</td>
                  <td>{p.role === "owner" ? "Owner" : "Teammate"}</td>
                  <td>{p.status === "invited" ? "Invited, not joined yet"
                    : p.login_ready_at ? "Set up"
                    : p.last_sign_in_at ? "Signed in with an email link" : "Not set up"}</td>
                  <td>{p.last_sign_in_at ? fmtDateTime(p.last_sign_in_at) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {owner && !owner.login_ready_at ? (
            <form action={sendLoginSetupAction} className="inline">
              <input type="hidden" name="orgId" value={customer.org.id} />
              <button type="submit">Send login setup email</button>
              <span className="muted" style={{ alignSelf: "center", fontSize: 13 }}>Goes to {owner.email}. Works once, for 7 days.</span>
            </form>
          ) : null}
        </div>

        <OnboardingSection orgId={customer.org.id} o={onboarding} flash={onb} />

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
