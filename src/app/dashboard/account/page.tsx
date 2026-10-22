import { getDb } from "@/lib/db/client";
import { listTeam, MAX_TEAMMATES, MIN_PASSWORD, orgsFor } from "@/lib/customer/auth";
import { requireCustomer } from "@/lib/customer/session";
import { DashboardShell } from "../shell";
import {
  changePasswordAction, inviteAction, removeTeammateAction, signOutEverywhereAction, switchBusinessAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account | Blogs on Tap" };

const PW: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Password changed. Other devices were signed out." },
  mismatch: { ok: false, text: "The two new passwords don't match." },
  wrong: { ok: false, text: "Your current password isn't right." },
};
const TEAM: Record<string, { ok: boolean; text: string }> = {
  sent: { ok: true, text: "Invite sent. It works for 7 days." },
  removed: { ok: true, text: "Removed. They're signed out of this business." },
  bad_email: { ok: false, text: "That email address doesn't look right." },
  already_member: { ok: false, text: "That person is already on your team." },
  too_many: { ok: false, text: `You can have up to ${MAX_TEAMMATES} teammates. Remove one first, or reply to any of our emails if you need more.` },
  not_owner: { ok: false, text: "Only the account owner can change the team." },
  not_found: { ok: false, text: "Couldn't find that person." },
};

const when = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "never";

export default async function AccountPage({ searchParams }: {
  searchParams: Promise<{ pw?: string; msg?: string; team?: string; devices?: string }>;
}) {
  const s = await requireCustomer("/dashboard/account");
  const sp = await searchParams;
  const db = await getDb();
  const [team, orgs] = await Promise.all([listTeam(db, s.orgId), orgsFor(db, s.userId)]);
  const pw = sp.pw === "weak" ? { ok: false, text: sp.msg || "Pick a stronger password." } : sp.pw ? PW[sp.pw] : null;
  const tm = sp.team ? TEAM[sp.team] : null;
  const owner = s.role === "owner";

  return (
    <DashboardShell s={s} active="account">
      <h1 style={{ margin: "0 0 16px" }}>Account</h1>

      <section className="card">
        <h2>Your login</h2>
        <div className="list-row"><span>Email</span><strong>{s.email}</strong></div>
        <div className="list-row"><span>Role</span><span>{owner ? "Owner" : "Teammate"}</span></div>
        <p className="help" style={{ margin: "12px 0 0" }}>Need a different email on the account? Reply to any of our emails and we'll change it.</p>
      </section>

      {orgs.length > 1 && (
        <section className="card">
          <h2>Your businesses</h2>
          <form action={switchBusinessAction} className="row-actions">
            <select name="orgId" defaultValue={s.orgId} aria-label="Business">
              {orgs.map((o) => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}
            </select>
            <button type="submit" className="secondary">Switch</button>
          </form>
        </section>
      )}

      <section className="card" id="password">
        <h2>{s.hasPassword ? "Change password" : "Set a password"}</h2>
        {pw && <p className={`flash ${pw.ok ? "ok" : "err"}`} role={pw.ok ? "status" : "alert"}>{pw.text}</p>}
        <form action={changePasswordAction} className="stack auth" style={{ margin: 0 }}>
          <input type="email" name="username" value={s.email} autoComplete="username" readOnly hidden />
          {s.hasPassword && (
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="current">Current password</label>
              <input id="current" name="current" type="password" autoComplete="current-password" required maxLength={200} />
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="password">New password</label>
            <p className="help">At least {MIN_PASSWORD} characters.</p>
            <input id="password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="confirm">Type it again</label>
            <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} />
          </div>
          <button type="submit">Save password</button>
        </form>
      </section>

      <section className="card" id="team">
        <h2>Team</h2>
        {tm && <p className={`flash ${tm.ok ? "ok" : "err"}`} role={tm.ok ? "status" : "alert"}>{tm.text}</p>}
        {team.map((t) => (
          <div className="list-row" key={t.user_id}>
            <div>
              <strong>{t.full_name && t.full_name !== s.orgName ? t.full_name : t.email}</strong>
              <div className="muted" style={{ fontSize: 13 }}>
                {t.email} · {t.role === "owner" ? "Owner" : t.status === "invited" ? "Invite sent" : `Teammate, last signed in ${when(t.last_sign_in_at)}`}
              </div>
            </div>
            {owner && t.role === "member" && (
              <form action={removeTeammateAction}>
                <input type="hidden" name="userId" value={t.user_id} />
                <button type="submit" className="secondary">{t.status === "invited" ? "Cancel invite" : "Remove"}</button>
              </form>
            )}
          </div>
        ))}
        {owner ? (
          <form action={inviteAction} className="stack auth" style={{ margin: "16px 0 0" }}>
            <h3 style={{ fontSize: 15, margin: "4px 0 0" }}>Invite a teammate</h3>
            <p className="help" style={{ margin: 0 }}>They can read and approve articles, pick topics and see the plan. Only you can change the team.</p>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="tm-name">Their name</label>
              <input id="tm-name" name="name" type="text" maxLength={120} autoComplete="off" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="tm-email">Their email</label>
              <input id="tm-email" name="email" type="email" required maxLength={254} autoComplete="off" />
            </div>
            <button type="submit">Send invite</button>
          </form>
        ) : (
          <p className="help" style={{ margin: "12px 0 0" }}>Only the account owner can invite or remove people.</p>
        )}
      </section>

      <section className="card" id="devices">
        <h2>Devices</h2>
        {sp.devices === "ok" && <p className="flash ok" role="status">Signed out everywhere else.</p>}
        <p className="help" style={{ marginTop: 0 }}>Lost a phone or used a shared computer? This signs you out everywhere except here.</p>
        <form action={signOutEverywhereAction}><button type="submit" className="secondary">Sign out other devices</button></form>
      </section>
    </DashboardShell>
  );
}
